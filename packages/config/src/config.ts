/**
 * Конфигурация приложения (ADR-0002).
 *
 * Единственное место во всём проекте, где читается окружение. Прямое обращение
 * к `process.env` за пределами этого модуля запрещено.
 *
 * Схема проверяется один раз при старте. При ошибке приложение падает, перечислив
 * **все** проблемные переменные сразу, а не первую — чтобы не чинить конфигурацию
 * по одной строке за перезапуск.
 *
 * В сообщениях об ошибках фигурируют только имена переменных. Значения секретов
 * не печатаются никогда: сообщение об ошибке — это тоже утечка.
 */

import { DomainError } from '@zvonix/shared';
import { z } from 'zod';

/**
 * Классификация переменных по чувствительности.
 *
 * Каждая переменная схемы обязана попасть ровно в один из двух списков — это
 * проверяется тестом. Иначе новая переменная с паролем незаметно окажется
 * «несекретной» и её значение уйдёт в лог при первой же ошибке конфигурации.
 */
const SECRET_VARIABLES = new Set(['DATABASE_URL', 'SECRET_KEY']);

const PUBLIC_VARIABLES = new Set([
  'APP_ENV',
  'APP_NAME',
  'APP_HOST',
  'APP_PORT',
  'LOG_LEVEL',
  'LOG_FORMAT',
]);

/** Переменные, отнесённые к секретным. Экспортируется для проверки полноты классификации. */
export const SECRET_VARIABLE_NAMES: readonly string[] = [...SECRET_VARIABLES].sort();

/** Переменные, значения которых безопасно печатать. */
export const PUBLIC_VARIABLE_NAMES: readonly string[] = [...PUBLIC_VARIABLES].sort();

const environment = z.enum(['development', 'test', 'production']);
const logLevel = z.enum(['debug', 'info', 'warn', 'error']);
const logFormat = z.enum(['pretty', 'json']);

const port = z.coerce
  .number()
  .int('должен быть целым числом')
  .min(1, 'должен быть больше нуля')
  .max(65535, 'должен быть не больше 65535');

export const configSchema = z.object({
  APP_ENV: environment.default('development'),
  APP_NAME: z.string().min(1, 'не может быть пустым').default('zvonix'),
  APP_HOST: z.string().min(1, 'не может быть пустым').default('127.0.0.1'),
  APP_PORT: port.default(8000),

  LOG_LEVEL: logLevel.default('info'),
  LOG_FORMAT: logFormat.default('json'),

  DATABASE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'должен начинаться с postgres:// или postgresql://',
    ),

  SECRET_KEY: z.string().min(32, 'должен быть не короче 32 символов'),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

/** Имена всех переменных, которые читает приложение. Используется для сверки с `.env.example`. */
export const CONFIG_VARIABLES: readonly string[] = Object.keys(configSchema.shape).sort();

/**
 * Ошибка конфигурации. Возникает только при старте и наружу по транспорту не уходит,
 * но остаётся доменной ошибкой, чтобы обработка на границах была единообразной.
 */
export class ConfigError extends DomainError {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const listing = problems.map((problem) => `  - ${problem}`).join('\n');
    super('internal', `Конфигурация не прошла проверку:\n${listing}`, {
      details: { variables: problems },
    });
    this.problems = problems;
  }
}

/**
 * Читает и проверяет конфигурацию.
 *
 * Источник передаётся явно, чтобы модуль можно было тестировать, не трогая
 * реальное окружение процесса.
 */
export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const result = configSchema.safeParse(source);
  if (result.success) {
    return Object.freeze(result.data);
  }
  throw new ConfigError(result.error.issues.map(describeIssue));
}

/**
 * Убирает значения секретов, оставляя пометку. Применяется перед выводом
 * конфигурации в лог: без этого пароль от базы окажется в первой же строке запуска.
 */
export function redactSecrets(config: Config): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_VARIABLES.has(key) ? '<скрыто>' : String(value),
    ]),
  );
}

export function isSecretVariable(name: string): boolean {
  return SECRET_VARIABLES.has(name);
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const name = issue.path.length > 0 ? String(issue.path[0]) : '<корень>';

  // Для секретов текст zod не используется: он может содержать полученное значение.
  if (SECRET_VARIABLES.has(name)) {
    return `${name}: значение не прошло проверку`;
  }

  const missing = issue.code === 'invalid_type' && issue.input === undefined;
  return missing ? `${name}: не задана` : `${name}: ${issue.message}`;
}
