/**
 * Ограничение частоты событий по ключу (ARCHITECTURE.md, компонент `limits`).
 *
 * Не путать с доменными лимитами клиента, канала, партнёра и SIM: те считаются
 * в PostgreSQL той же транзакцией, что создаёт вызов ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md)).
 * Здесь — защита от перебора: короткое окно, высокая частота, потеря счётчика допустима.
 *
 * Считает, сколько раз произошло событие с данным ключом за окно времени, и говорит,
 * не превышен ли предел. Хранилище — Redis: инкременты нужны атомарные и частые,
 * а PostgreSQL на каждый запрос входа — это запись в таблицу ради счётчика.
 *
 * **Состояния домена здесь нет.** Потеря базы Redis обнуляет счётчики — не более того.
 * Поэтому же счётчики не переживают перезапуск Redis, и это допустимо: окно короткое,
 * а вторая линия обороны (блокировка учётной записи) живёт в PostgreSQL.
 *
 * Окно фиксированное, а не скользящее. Известная слабость фиксированного окна —
 * до двойного всплеска на его стыке — для защиты от перебора несущественна: перебор
 * измеряется тысячами попыток, а не двадцатью против сорока. Скользящее окно потребовало бы
 * хранить отметку каждой попытки, то есть память, растущую с нагрузкой, — ровно в тот
 * момент, когда нагрузка и есть атака.
 */

import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { isRedisReady, RedisService } from '../../infra/redis.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';

/** Правило: сколько событий с одним ключом допустимо за окно. */
export interface LimitRule {
  /** Имя счётчика. Попадает в ключ Redis и в журнал: по нему видно, что именно сработало. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface LimitVerdict {
  readonly allowed: boolean;
  /** Сколько событий уже засчитано в текущем окне, включая это. */
  readonly current: number;
  /** Через сколько секунд окно закроется. Отдаётся вызывающему в заголовке `Retry-After`. */
  readonly retryAfterSeconds: number;
}

/**
 * Инкремент и срок жизни — одной операцией.
 *
 * Двумя командами это делать нельзя: между `INCR` и `EXPIRE` процесс может умереть,
 * и ключ останется без срока — то есть адрес окажется заблокирован навсегда, а причину
 * никто не найдёт. Скрипт выполняется в Redis целиком и такого промежутка не оставляет.
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

/** Чтение счётчика вместе со сроком: одна ходка вместо двух на каждый вход. */
const PEEK_SCRIPT = `
return {redis.call('GET', KEYS[1]) or '0', redis.call('PTTL', KEYS[1])}
`;

@Injectable()
export class RateLimitService implements OnApplicationBootstrap {
  private readonly logger: Logger;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('limits');
  }

  /**
   * Открывает соединение до того, как приложение начнёт слушать порт.
   *
   * Соединение создаётся при первом обращении, и без этого первые запросы после запуска
   * заставали бы его в состоянии «подключается»: проверка пропускалась бы, а в журнал
   * шла запись об ослабленной защите. Раз в выкат — этого достаточно, чтобы такие записи
   * перестали читать вовсе, а они здесь означают настоящую аварию.
   */
  onApplicationBootstrap(): void {
    void this.redis.connection;

    if (!this.config.AUTH_RATE_LIMIT_ENABLED) {
      // Выключенная защита обязана быть заметна. В production это не настройка,
      // а снятый рубеж обороны, и узнать о нём из переменной окружения через полгода —
      // не то же самое, что увидеть в журнале при каждом запуске.
      const message = 'Ограничение частоты входа выключено: защита от перебора по адресу снята';
      const fields = { variable: 'AUTH_RATE_LIMIT_ENABLED', env: this.config.APP_ENV };
      // Уровни различаются, а сигнатуры — нет: у `error` второй аргумент это причина,
      // и общая ссылка на метод уложила бы поля в запись как разобранную ошибку.
      if (this.config.APP_ENV === 'production') this.logger.error(message, undefined, fields);
      else this.logger.warn(message, fields);
    }
  }

  /**
   * Засчитывает событие и говорит, не превышен ли предел.
   *
   * При недоступном Redis пропускает и поднимает тревогу в журнале — довод при `SKIPPED`.
   */
  async hit(rule: LimitRule, subject: string): Promise<LimitVerdict> {
    const key = counterKey(rule.name, subject);
    const windowMs = rule.windowSeconds * 1000;

    const reply = await this.run(rule, (client) =>
      client.eval(INCREMENT_SCRIPT, 1, key, String(windowMs)),
    );
    if (reply === undefined) return SKIPPED;

    const [current, ttlMs] = parseReply(reply);
    return {
      allowed: current <= rule.limit,
      current,
      // `PTTL` возвращает −1 у ключа без срока и −2 у исчезнувшего: и то и другое
      // означает «окно вот-вот закроется», а не «ждать вечно».
      retryAfterSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : rule.windowSeconds,
    };
  }

  /**
   * Говорит, превышен ли предел, **не засчитывая событие**.
   *
   * Нужно там, где считать надо не обращения, а их исход. У входа считаются только
   * неудачи: иначе общий адрес конторы, откуда утром входят тридцать человек, упирался
   * бы в предел на ровном месте. Но проверить накопленное надо **до** работы — сверка
   * пароля стоит девятнадцати мегабайт и заметного времени, и раздавать её тому,
   * кто уже исчерпал предел, незачем.
   */
  async check(rule: LimitRule, subject: string): Promise<LimitVerdict> {
    const reply = await this.run(rule, (client) =>
      client.eval(PEEK_SCRIPT, 1, counterKey(rule.name, subject)),
    );
    if (reply === undefined) return SKIPPED;

    const [current, ttlMs] = parseReply(reply);
    return {
      allowed: current < rule.limit,
      current,
      retryAfterSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : rule.windowSeconds,
    };
  }

  /** Снимает счётчик: удачный вход обнуляет накопленные неудачи с этого адреса. */
  async reset(rule: LimitRule, subject: string): Promise<void> {
    await this.run(rule, (client) => client.del(counterKey(rule.name, subject)));
  }

  /**
   * Обращение к Redis с пути запроса. `undefined` означает «не выполнено».
   *
   * Состояние соединения проверяется до команды: пока сервер недоступен, ioredis
   * складывает команды в очередь и отдаёт после переподключения — то есть каждая проверка
   * честно ждёт свой предел времени. Ответ при этом известен заранее, а лишняя секунда
   * на каждом входе во время аварии Redis не нужна никому.
   */
  private async run(
    rule: LimitRule,
    command: (client: Redis) => Promise<unknown>,
  ): Promise<unknown> {
    const client = this.redis.connection;
    if (!isRedisReady(client)) {
      // Исключения здесь нет — есть состояние соединения, поэтому второй аргумент пуст:
      // иначе поля запроса лягут в запись как разобранная ошибка.
      this.logger.error(
        'Счётчик ограничений недоступен: проверка пропущена, защита ослаблена',
        undefined,
        { rule: rule.name, status: client.status },
      );
      return undefined;
    }

    try {
      return await command(client);
    } catch (cause) {
      this.logger.error(
        'Счётчик ограничений недоступен: проверка пропущена, защита ослаблена',
        cause,
        { rule: rule.name },
      );
      return undefined;
    }
  }
}

/**
 * Вердикт, когда счётчик недоступен.
 *
 * **Пропускаем.** Довод целиком: этот счётчик — не единственная защита. Перебор пароля
 * по одной записи закрывает блокировка учётной записи, которая живёт в PostgreSQL
 * и работает независимо. Отказ же на этом месте закрыл бы вход **всем**, включая
 * администратора, которому и предстоит чинить упавший Redis. Цена ошибки несимметрична:
 * ослабленный второй рубеж против недоступности системы.
 */
const SKIPPED: LimitVerdict = { allowed: true, current: 0, retryAfterSeconds: 0 };

/**
 * Ключ счётчика.
 *
 * Пространство имён отделяет счётчики от очереди фоновых задач, живущей в той же базе:
 * без него `FLUSH` по одному хозяйству задел бы другое, а разбор «что здесь лежит»
 * стал бы гаданием.
 */
export function counterKey(rule: string, subject: string): string {
  return `zvonix:limit:${rule}:${subject}`;
}

/** Ответ скрипта: пара чисел. Разбирается явно — `eval` типизирован как `unknown`. */
function parseReply(reply: unknown): [current: number, ttlMs: number] {
  if (!Array.isArray(reply) || reply.length < 2) return [0, 0];
  return [Number(reply[0]), Number(reply[1])];
}
