/**
 * Работа с Redis: разбор адреса, разовое соединение и проверка пригодности.
 *
 * Живёт в инфраструктуре API, а не в воркере, потому что потребителей стало два:
 * расписание фоновых задач (ADR-0020) и счётчики окон в модуле `limits`. Своя копия разбора адреса в каждом процессе
 * разошлась бы на первом же `rediss://` или номере базы в пути.
 *
 * **Redis не хранит состояние домена.** Источник истины всегда PostgreSQL: потеря всей
 * базы Redis означает пропуск нескольких проходов уборки и обнуление счётчиков окон,
 * а не потерю данных.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { dependencyUnavailable } from '@zvonix/shared';
import { Redis, type RedisOptions } from 'ioredis';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from './tokens.js';

/**
 * Разбор адреса — и только он.
 *
 * Делает его сам ioredis: своя реализация разошлась бы с ним на первом же `rediss://`,
 * имени пользователя или номере базы в пути.
 *
 * Дальше настройки расходятся, и расходятся принципиально. **Очередь обязана ждать
 * возвращения Redis сколь угодно долго; путь запроса — не ждать почти совсем.**
 * Один набор настроек на обоих означал бы либо срыв блокирующего чтения очереди,
 * либо вход, висящий вместе с недоступным Redis.
 */
function parseRedisUrl(url: string): RedisOptions {
  const probe = new Redis(url, { lazyConnect: true });
  const options: RedisOptions = {
    ...probe.options,
    // `lazyConnect` — приём разбора адреса, а не желаемая настройка. Протащенный
    // дальше, он оставляет соединение BullMQ в состоянии «подключается», и при закрытии
    // тот рвёт сокет вместо `quit`: команды, висевшие в этот момент, отклоняются
    // в пустоту необработанным отказом. Проверено.
    lazyConnect: false,
  };
  // Сокет не открывался: с `lazyConnect` соединение устанавливается первой командой.
  probe.disconnect();
  return options;
}

/**
 * Настройки соединения для очереди фоновых задач.
 *
 * BullMQ получает **настройки, а не готовое соединение**: соединение, переданное снаружи,
 * он считает чужим и при остановке не закрывает — а блокирующее чтение очереди остаётся
 * висеть. Дальше его обрывает уже наш `quit`, и висевшая команда отклоняется в пустоту.
 * Проверено: именно так и происходит.
 */
export function redisConnectionOptions(url: string): RedisOptions {
  return {
    ...parseRedisUrl(url),
    // Обязательно для BullMQ: рабочий процесс читает очередь блокирующей командой,
    // и при конечном числе повторов ioredis обрывает её ошибкой вместо ожидания.
    maxRetriesPerRequest: null,
  };
}

/** Сколько ждать соединения при разовой проверке. */
const PROBE_CONNECT_TIMEOUT_MS = 5000;

/**
 * Соединение для разовых команд мимо очереди: проверка настроек, очистка в проверках.
 *
 * Настройки противоположны очереди: **одна попытка и никаких повторов**. Очередь при
 * обрыве обязана дождаться возвращения Redis, а проверка при старте — наоборот, обязана
 * сразу сказать, что его нет. С бесконечными повторами процесс молча висел бы
 * на первой же команде, выглядя запускающимся.
 */
export function createProbeConnection(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: PROBE_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

/**
 * То, что нужно от Redis для проверки политики.
 *
 * Структурный тип, а не `Redis` целиком: проверке достаточно одной команды, и с таким
 * параметром её можно прогнать без живого сервера — а с живым она проверяла бы ровно
 * то же самое.
 */
export interface ConfigReader {
  call(command: string, ...args: string[]): Promise<unknown>;
}

/**
 * Отказ запускаться при политике вытеснения.
 *
 * При любой политике, кроме `noeviction`, Redis под давлением памяти выбрасывает ключи
 * **молча**. Для очереди это означает исчезнувшее задание: уборка не выполнена, и никто
 * об этом не узнал. Предупреждения в журнале здесь мало — процесс, который не может
 * выполнять свою работу надёжно, не должен делать вид, что работает.
 *
 * Отдельно разбирается случай, когда проверить нельзя: на управляемом Redis команда
 * `CONFIG` бывает отключена. Это не то же самое, что несоответствие, и запрещать запуск
 * из-за невозможности проверки неверно — но и промолчать нельзя.
 */
export async function assertNoEvictionPolicy(redis: ConfigReader, logger: Logger): Promise<void> {
  let reply: unknown;
  try {
    reply = await redis.call('CONFIG', 'GET', 'maxmemory-policy');
  } catch (cause) {
    logger.warn(
      'Политику вытеснения Redis проверить не удалось: команда CONFIG недоступна. ' +
        'Убедитесь вручную, что задана maxmemory-policy noeviction',
      { reason: String(cause) },
    );
    return;
  }

  // Ответ `CONFIG GET` — плоский список пар: ['maxmemory-policy', 'noeviction'].
  const policy = Array.isArray(reply) && reply.length >= 2 ? String(reply[1]) : undefined;
  if (policy === undefined) {
    logger.warn('Redis вернул неожиданный ответ на CONFIG GET maxmemory-policy');
    return;
  }

  if (policy !== 'noeviction') {
    throw dependencyUnavailable(
      `Redis настроен с maxmemory-policy=${policy}: при вытеснении задания пропадают молча. ` +
        'Требуется noeviction',
    );
  }
}

/**
 * Сколько ждать ответа на команду с пути запроса и сколько раз её повторить.
 *
 * Счётчик окна — не то, ради чего человек согласен ждать: вход должен состояться
 * или не состояться быстро. Секунда — потолок, до которого дело в норме не доходит.
 */
const COMMAND_TIMEOUT_MS = 1000;
const REQUEST_PATH_RETRIES = 1;

/**
 * Соединение с Redis на время жизни процесса.
 *
 * Создаётся **при первом обращении**, а не при старте: Redis нужен не всякому процессу
 * и не на каждом запросе, а соединение, открытое впустую, только мешает — при
 * недоступном сервере оно бесконечно переподключается и шумит в журнале.
 *
 * В отличие от разового соединения, здесь повторы не ограничены: потребитель — счётчики
 * окон, и им правильно дождаться возвращения Redis, а не отказать навсегда.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger: Logger;
  private client: Redis | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('redis');
  }

  get connection(): Redis {
    if (this.client === undefined) {
      this.client = new Redis({
        ...parseRedisUrl(this.config.REDIS_URL),
        // Настройки пути запроса, противоположные очереди. Без предела ожидания
        // недоступный Redis не «пропускал бы проверку», как задумано, а **вешал вход**:
        // команда ждала бы возвращения сервера вечно. Проверено.
        maxRetriesPerRequest: REQUEST_PATH_RETRIES,
        commandTimeout: COMMAND_TIMEOUT_MS,
      });
      // Без обработчика ioredis выбрасывает ошибку соединения как необработанную,
      // и процесс падает из-за недоступности вспомогательного хранилища.
      this.client.on('error', (error: Error) => {
        this.logger.error('Ошибка соединения с Redis', error);
      });
    }
    return this.client;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client === undefined) return;
    // `quit` дожидается ответа сервера; при уже оборванной связи он отклоняется,
    // и это не повод падать при остановке.
    await this.client.quit().catch(() => {
      this.client?.disconnect();
    });
    this.client = undefined;
  }
}

/**
 * Готово ли соединение принимать команды **прямо сейчас**.
 *
 * Нужно потребителям с пути запроса: пока Redis недоступен, ioredis складывает команды
 * в очередь и отдаёт их после переподключения, то есть каждая проверка честно ждёт
 * свой предел времени. Пока сервер лежит, это лишняя секунда на каждом входе —
 * при том, что ответ заранее известен.
 *
 * При старте соединение какое-то время не готово, и первые проверки будут пропущены.
 * Это осознанная цена: пропустить единичную проверку второго рубежа дешевле,
 * чем задержать вход всем.
 */
export function isRedisReady(client: Redis): boolean {
  return client.status === 'ready';
}
