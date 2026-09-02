/**
 * Соединение с Redis для расписания и очереди фоновых задач (ADR-0020).
 *
 * Redis здесь — не хранилище домена, а только расписание. Источник истины всегда
 * PostgreSQL, поэтому потеря всей базы Redis означает пропуск нескольких проходов
 * уборки и перевыпуск расписания при старте, а не потерю данных.
 */

import { dependencyUnavailable } from '@zvonix/shared';
import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '@zvonix/api';

/**
 * Настройки соединения из адреса.
 *
 * BullMQ получает **настройки, а не готовое соединение**: соединение, переданное снаружи,
 * он считает чужим и при остановке не закрывает — а блокирующее чтение очереди остаётся
 * висеть. Дальше его обрывает уже наш `quit`, и висевшая команда отклоняется в пустоту.
 * Проверено: именно так и происходит.
 *
 * Разбор адреса делает сам ioredis: своя реализация разошлась бы с ним на первом же
 * `rediss://`, имени пользователя или номере базы в пути.
 */
export function redisConnectionOptions(url: string): RedisOptions {
  const probe = new Redis(url, { lazyConnect: true });
  const options: RedisOptions = {
    ...probe.options,
    // Обязательно для BullMQ: рабочий процесс читает очередь блокирующей командой,
    // и при конечном числе повторов ioredis обрывает её ошибкой вместо ожидания.
    maxRetriesPerRequest: null,
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
