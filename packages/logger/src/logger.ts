/**
 * Логгер (ADR-0004).
 *
 * Структурированный JSON в production, читаемая строка локально. Обязательные поля
 * каждой записи: `timestamp`, `level`, `message`, `correlation_id`, `component`.
 * Всё дополнительное — отдельными полями, а не склейкой в текст сообщения: иначе
 * по логам нельзя фильтровать.
 *
 * Транспорт — pino: логируется каждый вызов, и собственная реализация записи
 * в поток была бы худшим местом для экономии.
 */

import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoOptions,
} from 'pino';
import { currentCorrelationId } from './context.js';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

/** Дополнительные поля записи. Значения проходят маскирование перед выводом. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  /** Ошибка передаётся отдельным аргументом: она разворачивается со стеком и причиной. */
  error(message: string, error?: unknown, fields?: LogFields): void;
  /** Дочерний логгер с другим компонентом и, при необходимости, постоянными полями. */
  child(component: string, fields?: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: LogFormat;
  /** Имя модуля или сервиса. Попадает в поле `component` каждой записи. */
  readonly component: string;
  /** Поля, добавляемые ко всем записям: имя приложения, версия, среда. */
  readonly base?: LogFields;
}

const PRETTY_TAG: Record<string, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/**
 * Создаёт логгер.
 *
 * `destination` передаётся в тестах, чтобы читать вывод. В приложении не указывается:
 * без потока pino пишет в стандартный вывод, откуда записи забирает сборщик логов.
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const stream = destination ?? (options.format === 'pretty' ? createPrettyStream() : undefined);

  const settings: PinoOptions = {
    level: options.level,
    messageKey: 'message',
    base: { ...options.base },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: (bindings: Record<string, unknown>) => {
        // pid и hostname pino добавляет по умолчанию, в нашей схеме их нет.
        const rest = { ...bindings };
        delete rest['pid'];
        delete rest['hostname'];
        return rest;
      },
    },
    // Идентификатор берётся из контекста в момент записи, а не передаётся вручную
    // в каждый вызов: иначе его забудут в первой же новой функции.
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId === undefined ? {} : { correlation_id: correlationId };
    },
  };

  const root = stream === undefined ? pino(settings) : pino(settings, stream);
  return wrap(root.child({ component: options.component }));
}

function wrap(instance: PinoLogger): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    instance[level](fields === undefined ? {} : (redact(fields) as object), message);
  };

  return {
    debug: (message, fields) => {
      write('debug', message, fields);
    },
    info: (message, fields) => {
      write('info', message, fields);
    },
    warn: (message, fields) => {
      write('warn', message, fields);
    },
    error: (message, error, fields) => {
      const payload: Record<string, unknown> = fields === undefined ? {} : { ...fields };
      if (error !== undefined) payload['error'] = error;
      instance.error(redact(payload) as object, message);
    },
    child: (component, fields) =>
      wrap(instance.child({ component, ...(redact(fields ?? {}) as object) })),
  };
}

/**
 * Читаемый вывод для разработки.
 *
 * Своя реализация вместо готового пакета: схема записи у нас фиксированная,
 * и полтора десятка строк дают ровно нужный вид — без ещё одной зависимости
 * и без рабочего потока, который усложнил бы тесты.
 */
function createPrettyStream(): DestinationStream {
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;

  return {
    write(line: string): void {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stdout.write(line);
        return;
      }

      const { timestamp, level, message, component, correlation_id: trace, ...rest } = entry;

      const time = text(timestamp, '').slice(11, 23);
      const levelName = text(level, 'info');
      const label = PRETTY_TAG[levelName] ?? levelName.toUpperCase();
      const tail = Object.keys(rest).length > 0 ? '  ' + JSON.stringify(rest) : '';
      const short = typeof trace === 'string' ? ' ' + trace.slice(0, 8) : '';

      process.stdout.write(
        `${time} ${label}${short} [${text(component, '-')}] ${text(message, '')}${tail}\n`,
      );
    },
  };
}
