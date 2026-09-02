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
const SECRET_VARIABLES = new Set(['DATABASE_URL', 'SECRET_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']);

const PUBLIC_VARIABLES = new Set([
  'APP_ENV',
  'APP_NAME',
  'APP_HOST',
  'APP_PORT',
  'PUBLIC_BASE_URL',
  'SIP_REALM',
  'MAX_CALL_DURATION_SECONDS',
  'RESERVATION_TTL_SECONDS',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'RECORDING_RETENTION_DAYS',
  'RECORDING_LINK_TTL_SECONDS',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'DATABASE_POOL_MAX',
  'OPERATOR_LOOKUP_ENABLED',
  'OPERATOR_LOOKUP_URL',
  'OPERATOR_LOOKUP_RPS',
  'NUMBER_RESOLUTION_TTL_DAYS',
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

  /**
   * Адрес, по которому control plane виден **снаружи**: из него собирается команда
   * установки узла и адреса, которые узел пишет себе в конфигурацию.
   *
   * `APP_HOST` для этого не годится: там адрес, который слушает процесс, и за обратным
   * прокси это `127.0.0.1`. Узел, получивший такую команду, обратится сам к себе.
   *
   * Обязателен `https`: по этому каналу уходит секрет ключа в схеме Basic (ADR-0019).
   * В разработке допускается `http` на локальном адресе — иначе локально ничего
   * не проверить, а сертификата для `localhost` нет.
   */
  PUBLIC_BASE_URL: z
    .url('должен быть адресом вида https://cp.example.com')
    .refine(
      (value) =>
        value.startsWith('https://') ||
        value.startsWith('http://127.0.0.1') ||
        value.startsWith('http://localhost'),
      'должен быть https: по этому каналу уходит секрет ключа',
    )
    .default('http://127.0.0.1:8000'),

  /**
   * Realm SIP — общий для всей платформы, а не свой у каждого узла.
   *
   * Это не косметика. Digest-проверка SIP считает `MD5(имя:realm:пароль)`, и мы храним
   * именно этот хеш вместо пароля. Свой realm у каждого узла означал бы, что хеш годится
   * только на одном узле: шлюз, перерегистрировавшийся на соседний, перестал бы
   * проходить проверку — а перерегистрация это штатный способ пережить отказ узла.
   *
   * Менять значение после выдачи учётных записей нельзя: все хеши станут недействительны
   * разом, и все шлюзы отвалятся.
   */
  SIP_REALM: z
    .string()
    .min(3, 'слишком короткий')
    .max(253, 'слишком длинный')
    .regex(/^[a-z0-9.-]+$/, 'должен быть именем в нижнем регистре, без схемы и порта')
    .default('sip.zvonix.local'),

  /**
   * Предельная длительность вызова в секундах.
   *
   * От неё считается сумма резерва: резервируется стоимость разговора этой длительности.
   * Значение задаёт компромисс — слишком малое обрежет длинный разговор, слишком большое
   * заморозит у клиента лишние деньги и сократит число одновременных вызовов, которые
   * он может начать.
   */
  MAX_CALL_DURATION_SECONDS: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(60, 'меньше минуты — это не разговор')
    .max(14_400, 'дольше четырёх часов — это зависший вызов, а не разговор')
    .default(3600),

  /**
   * Через сколько секунд резерв освобождается сам.
   *
   * Страховка от потерянного CDR: без неё замороженный остаток не размораживается
   * никогда, клиент перестаёт звонить, и причина не видна ниоткуда. Заведомо больше
   * предельной длительности вызова — иначе резерв истечёт посреди разговора.
   */
  RESERVATION_TTL_SECONDS: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(300, 'слишком короткий срок: резерв истечёт посреди разговора')
    .max(86_400, 'слишком долгий срок заморозки средств')
    .default(7200),

  /**
   * Объектное хранилище записей разговоров.
   *
   * Записи не лежат ни в базе, ни на узле: объём растёт линейно и бесконечно,
   * а узел одноразов и заменяем (ARCHITECTURE.md).
   */
  S3_ENDPOINT: z.url('должен быть адресом').default('http://127.0.0.1:9000'),
  S3_BUCKET: z
    .string()
    .min(3, 'слишком короткое')
    .max(63, 'слишком длинное')
    .regex(/^[a-z0-9.-]+$/, 'имя корзины — строчные буквы, цифры, точка и дефис')
    .default('zvonix-recordings'),
  S3_REGION: z.string().min(1, 'не может быть пустым').default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1, 'не может быть пустым').default(''),
  S3_SECRET_KEY: z.string().min(1, 'не может быть пустым').default(''),

  /**
   * Сколько хранится запись разговора, в сутках.
   *
   * Записи — персональные данные абонента, и «навсегда» здесь не нейтральное значение,
   * а решение хранить чужие разговоры бессрочно. Срок задаётся явно и по истечении
   * запись удаляется вместе с объектом в хранилище.
   */
  RECORDING_RETENTION_DAYS: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(1, 'должно быть больше нуля')
    .max(3650, 'слишком долгий срок хранения персональных данных')
    .default(90),

  /**
   * Срок жизни подписанной ссылки на запись, в секундах.
   *
   * Короткий намеренно: ссылка даёт доступ к разговору без всякой проверки прав,
   * поэтому пересланная в мессенджере она должна протухнуть раньше, чем её откроют
   * посторонние. Пятнадцать минут хватает послушать, но не хватает разослать.
   */
  RECORDING_LINK_TTL_SECONDS: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(60, 'слишком короткий срок: ссылку не успеют открыть')
    .max(3600, 'слишком долгий срок жизни ссылки на персональные данные')
    .default(900),

  LOG_LEVEL: logLevel.default('info'),
  LOG_FORMAT: logFormat.default('json'),

  DATABASE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'должен начинаться с postgres:// или postgresql://',
    ),

  /**
   * Верхняя граница соединений с базой у одного процесса.
   *
   * Задаётся переменной, а не константой: у API, воркера и потребителя событий разная
   * нагрузка, а сумма по всем процессам всех узлов ограничена сверху значением
   * `max_connections` на сервере PostgreSQL. Превышение проявляется не замедлением,
   * а отказом соединяться — сразу у всех.
   */
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int('должен быть целым числом')
    .min(1, 'должен быть больше нуля')
    .max(100, 'должен быть не больше 100')
    .default(10),

  /**
   * Обращаться ли к внешнему сервису определения оператора (ADR-0013).
   *
   * Отключается, когда сервис недоступен или у узла нет российского IP — без него
   * останется только план нумерации, а он оператора не подтверждает, и вызовы будут
   * отклоняться. Это осознанная деградация, а не тихая: отключать должен человек.
   */
  OPERATOR_LOOKUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  OPERATOR_LOOKUP_URL: z.url('должен быть адресом').default('http://num.voxlink.ru/get/'),

  /**
   * Запросов в секунду к внешнему сервису.
   *
   * Лимит источника — десять, и подходить к нему вплотную нельзя: бесплатный сервис
   * без гарантий легко потерять, выжигая его нагрузкой. Значение по умолчанию —
   * впятеро ниже разрешённого.
   */
  OPERATOR_LOOKUP_RPS: z.coerce
    .number()
    .positive('должен быть больше нуля')
    .max(10, 'выше лимита источника')
    .default(2),

  /**
   * Срок годности записи об операторе номера, в сутках.
   *
   * Кэш «навсегда» неверен: абонент может перенести номер повторно, а ложная запись
   * означает платный звонок вместо бесплатного. Тридцать суток при базе в сто тысяч
   * номеров дают около 0,04 запроса в секунду — при разрешённых десяти.
   */
  NUMBER_RESOLUTION_TTL_DAYS: z.coerce
    .number()
    .int('должен быть целым числом')
    .min(1, 'должен быть больше нуля')
    .max(365, 'слишком долгий срок годности')
    .default(30),

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
  if (!result.success) {
    throw new ConfigError(result.error.issues.map(describeIssue));
  }

  const problems = crossFieldProblems(result.data);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return Object.freeze(result.data);
}

/**
 * Проверки, связывающие несколько переменных.
 *
 * Вынесены из схемы отдельной функцией, а не выражены через `refine`: `refine`
 * превращает объектную схему в обёртку и отбирает `shape`, по которому строится
 * список переменных для сверки с `.env.example`.
 */
function crossFieldProblems(config: z.infer<typeof configSchema>): string[] {
  const problems: string[] = [];

  if (config.RESERVATION_TTL_SECONDS <= config.MAX_CALL_DURATION_SECONDS) {
    // Иначе резерв истечёт посреди разговора: деньги освободятся, вызов продолжится,
    // и клиент уйдёт в минус глубже разрешённого — ровно то, что резерв предотвращает.
    problems.push(
      'RESERVATION_TTL_SECONDS: должен быть больше MAX_CALL_DURATION_SECONDS, ' +
        'иначе резерв истечёт посреди разговора',
    );
  }

  return problems;
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
