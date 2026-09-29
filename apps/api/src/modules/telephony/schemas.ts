/**
 * Схемы входных данных телефонии (ADR-0009).
 */

import {
  CALL_FAILURE_REASONS,
  CALL_STATUSES,
  CHANNEL_STATUSES,
  DEFAULT_TRUNK_CONCURRENT_CALLS,
  GATEWAY_REGISTRATION_MODES,
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  MAX_CONCURRENT_CALLS_LIMIT,
  MAX_TRUNK_CONCURRENT_CALLS,
  dialledDigits,
  normalizeMsisdn,
  SIM_STATUSES,
  TERMINATION_KINDS,
  type CallDestination,
  type Msisdn,
} from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

/** Портов у шлюза. Самые большие GOIP — на 32 слота; 256 с запасом отсекает опечатку. */
export const MAX_GATEWAY_PORTS = 256;

const name = z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное');

export const createGatewaySchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),
  name,
  type: z.enum(GATEWAY_TYPES),
  model: z.string().trim().max(100, 'слишком длинная').optional(),
  /** Число портов под SIM. У Android-шлюза один. */
  portCount: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(0, 'не может быть отрицательным')
    .max(MAX_GATEWAY_PORTS, 'неправдоподобно много')
    .default(0),
  /**
   * Способ подключения ([ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
   * Пропущен — `gateway`, как до появления поля: смысл прежних обращений не меняется.
   */
  registrationMode: z.enum(GATEWAY_REGISTRATION_MODES).optional(),
});

/** Смена способа подключения шлюза (ADR-0054). Допустимость проверяет служба. */
export const registrationModeSchema = z.object({
  mode: z.enum(GATEWAY_REGISTRATION_MODES),
});

/**
 * Тариф шлюза или SIM ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)).
 * `null` — «как у шлюза» для SIM и «тариф по умолчанию» для шлюза.
 */
export const tariffChoiceSchema = z.object({
  tariffId: z.uuid('должен быть идентификатором').nullable(),
});

/**
 * Шлюз, который заводит **сам партнёр** ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
 *
 * Идентификатор партнёра берётся из сессии, поэтому его здесь нет: подставить чужой
 * нечего — этим собственный контур и отличается от административного.
 *
 * Транк партнёру недоступен: он привязывается к узлу площадки, а узлы — не его дело.
 */
export const partnerGatewaySchema = createGatewaySchema.omit({ partnerId: true }).extend({
  type: z.enum(['goip', 'android']),
});

/**
 * Партнёр включает, выключает и списывает своё оборудование, но не снимает
 * отключение, поставленное площадкой. Переходы проверяет служба, а не схема:
 * допустимость зависит от текущего состояния, а его схема не видит.
 */
export const partnerGatewayStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'retired']),
});

/**
 * Состояния карты, которыми распоряжается сам партнёр.
 *
 * `active` проходит только с подтверждённым оператором, `retired` — только у карты
 * вне порта. Ни то, ни другое схеме не видно: она про форму запроса, а не про то,
 * что сейчас в базе.
 */
export const partnerSimStatusSchema = z.object({
  status: z.enum(['active', 'retired']),
});

export const gatewayStatusSchema = z.object({
  status: z.enum(GATEWAY_STATUSES),
});

export const createChannelSchema = z.object({
  clientId: z.uuid('должен быть идентификатором'),
  name,
  /**
   * Требуется ли запись разговора. Канал с этим признаком никогда не уходит на шлюз
   * типа `android`: там запись технически невозможна (ADR-0012).
   */
  recordingRequired: z.boolean().default(false),
  /** Номер, который увидит вызываемый. Пусто — номер SIM, с которой ушёл вызов. */
  callerId: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{3,15}$/, 'должен быть номером')
    .optional(),
});

export const channelStatusSchema = z.object({
  status: z.enum(CHANNEL_STATUSES),
});

/**
 * Запрос каталога от `mod_xml_curl`.
 *
 * Тело — `application/x-www-form-urlencoded`, а не JSON: другого формата у модуля нет.
 * Состав полей у FreeSWITCH меняется от версии к версии, поэтому проверяются только
 * те, без которых нельзя ответить, а остальные игнорируются: строгая проверка «лишних
 * полей нет» ломала бы телефонию при обновлении узла.
 */
export const directoryRequestSchema = z
  .object({
    section: z.literal('directory', { error: 'ожидается запрос каталога' }),
    /** Имя учётной записи. FreeSWITCH шлёт его в `user`, иногда только в `key_value`. */
    user: z.string().trim().min(1).max(100).optional(),
    key_value: z.string().trim().max(253).optional(),
    /** Что происходит: `sip_auth` при регистрации, `user_call` при вызове. */
    action: z.string().trim().max(50).optional(),
    hostname: z.string().trim().max(255).optional(),
  })
  .loose();

export const createSimSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),

  /**
   * Оператор, которого объявляет партнёр. Сверяется с ответом резолвера по собственному
   * номеру SIM: подтверждённое расхождение — отказ, а не предупреждение. Не указан —
   * берётся тот, кого назвал резолвер; не назвал — отказ: карта без оператора
   * не маршрутизируется вовсе.
   */
  operatorId: z.uuid('должен быть идентификатором').optional(),

  /** Собственный номер SIM. Нормализуется: `8916…`, `+7 916 …` и `7916…` — одно и то же. */
  msisdn: z
    .string()
    .trim()
    .min(1, 'не может быть пустым')
    .transform((value, ctx): Msisdn => {
      const normalized = normalizeMsisdn(value);
      if (normalized === undefined) {
        ctx.addIssue({ code: 'custom', message: 'не похоже на российский номер' });
        return '70000000000' as Msisdn;
      }
      return normalized;
    }),

  /** Идентификатор чипа: 19–20 цифр. */
  iccid: z
    .string()
    .trim()
    .regex(/^[0-9]{18,22}$/, 'должен быть числом из 18–22 цифр')
    .optional(),

  /** Дата активации у оператора. По ней считается возраст SIM в антифроде. */
  activatedAt: z.iso.datetime({ error: 'должна быть датой в формате ISO' }).optional(),
});

/** SIM, которую заводит сам партнёр. Оператор сверяется с источником при заведении. */
export const partnerSimSchema = createSimSchema.omit({ partnerId: true });

export const simStatusSchema = z.object({
  status: z.enum(SIM_STATUSES),
});

export const simConcurrencySchema = z.object({
  /**
   * Одновременных вызовов на SIM. Инвариант DOMAIN.md: меняет только администратор —
   * превышение это прямой путь к блокировке SIM оператором.
   */
  maxConcurrentCalls: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(1, 'не может быть меньше одного')
    .max(MAX_CONCURRENT_CALLS_LIMIT, 'выше разумного предела'),
});

/**
 * Новый порт: либо с номером, как он подписан на корпусе, либо несколько следующих
 * по порядку — `count` штук после наибольшего заведённого.
 */
export const addPortSchema = z.union(
  [
    z.object({
      portNumber: z.coerce
        .number()
        .int('должен быть целым числом')
        .min(1, 'нумерация портов начинается с единицы')
        .max(MAX_GATEWAY_PORTS, 'неправдоподобно много'),
    }),
    z.object({
      count: z.coerce
        .number()
        .int('должно быть целым числом')
        .min(1, 'хотя бы один')
        .max(MAX_GATEWAY_PORTS, 'неправдоподобно много'),
    }),
  ],
  { error: 'нужен номер порта (portNumber) или количество (count)' },
);

export const assignSimSchema = z.object({
  /** `null` означает «вынуть SIM из порта». */
  simCardId: z.uuid('должен быть идентификатором').nullable(),
});

/**
 * Порядок партнёров в канале (ADR-0014).
 *
 * Партнёр называется **псевдонимом**, а не идентификатором: клиент знает о нём только
 * псевдоним, и приём `partner_id` здесь означал бы, что клиенту его где-то показали.
 *
 * Пустой список допустим и означает «снять ограничения»: канал вернётся к перебору
 * всех партнёров. Это не то же самое, что «никого не разрешать», — запретить все
 * направления сразу можно отключением канала.
 */
export const partnerPrioritiesSchema = z.object({
  priorities: z
    .array(
      z.object({
        aliasId: z.uuid('должен быть идентификатором псевдонима'),

        /**
         * Через что уходит вызов. Единица приоритета — предложение, то есть партнёр
         * вместе со способом терминации (ADR-0040): у партнёра с SIM и транком это
         * две отдельные строки с разными ценами.
         *
         * Умолчание `sim` — совместимость: на момент появления поля другого способа
         * не существует, и прежние списки означают ровно то же, что и означали.
         */
        terminationKind: z.enum(TERMINATION_KINDS).default('sim'),
        /** Меньше — раньше. Равные означают «делить трафик поровну» (ADR-0021). */
        priority: z.coerce
          .number()
          .int('должен быть целым числом')
          .min(1, 'нумерация приоритетов начинается с единицы')
          .max(1000, 'неправдоподобно много уровней'),
      }),
    )
    .max(200, 'больше партнёров, чем бывает'),
});

/**
 * Регионы, в которые партнёр принимает вызовы (ADR-0022).
 *
 * Названия — свободным текстом: справочника регионов у платформы нет, и сравнение идёт
 * по приведённому написанию. Пустой список допустим и означает «все регионы» —
 * то же самое, что «ограничений нет».
 */
export const partnerCoverageSchema = z.object({
  regions: z
    .array(
      z.string().trim().min(2, 'слишком короткое название').max(100, 'слишком длинное название'),
    )
    .max(200, 'больше регионов, чем бывает'),
});

/**
 * Операторы, на которых каналу разрешено звонить (ADR-0025).
 *
 * Пустой список допустим и означает «все операторы» — то есть снятие ограничения,
 * а не запрет всего: закрыть линию целиком можно её состоянием.
 */
export const allowedOperatorsSchema = z.object({
  operators: z
    .array(z.uuid('должен быть идентификатором оператора'))
    .max(200, 'больше операторов, чем бывает'),
});

/**
 * Порог автоматического отключения (ADR-0027).
 *
 * Область задаётся путём, а не телом: порог на область ровно один, и `PUT` по ней
 * читается как «вот такой порог у SIM», а не «вот ещё один порог».
 */
export const failureThresholdSchema = z.object({
  /** Единица означала бы отключение с первого отказа — а он бывает и на исправной SIM. */
  failures: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(2, 'один отказ случается и на исправной SIM')
    .max(10_000, 'неправдоподобно много'),

  /** Длина скользящего окна в минутах. Месяц — верхняя граница осмысленного. */
  windowMinutes: z.coerce
    .number()
    .int('должно быть целым числом минут')
    .min(1, 'окно короче минуты бессмысленно')
    .max(44_640, 'окно длиннее месяца бессмысленно'),
});

/**
 * Правка настроек канала.
 *
 * Все поля необязательны: форма шлёт только изменившееся, и «поле не пришло»
 * означает «не трогать», а не «очистить». Очистка номера для показа выражается
 * явным `null` — это разные намерения.
 */
export const updateChannelSchema = z
  .object({
    name: name.optional(),
    recordingRequired: z.boolean().optional(),
    callerId: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{3,15}$/, 'должен быть номером')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Нечего менять: не передано ни одного поля',
  });

/**
 * Потолок страницы вызовов.
 *
 * Строка вызова короткая, но список открывают ради разбора, а не выгрузки: две сотни
 * строк — это уже не «посмотреть, что происходит».
 */
const CALLS_PAGE_MAX = 200;

/**
 * Пустое значение параметра — «любое», а не «пустое».
 *
 * Форма отбора шлёт все свои поля, и `?status=` означает «любое состояние».
 * Без этого сброс фильтра в кабинете давал бы отказ вместо полного списка.
 */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

/** Момент времени в виде ISO. Негодная строка — отказ: молча показать не тот период хуже. */
const moment = optional(
  z.iso.datetime({ offset: true, message: 'должен быть моментом времени в виде ISO' }),
);

/**
 * Номер назначения целиком.
 *
 * Приводится к каноническому виду теми же правилами, что и на пути вызова: в базе
 * лежит `7XXXXXXXXXX`, а человек набирает в отборе то, что видит у себя — `8…`, `+7…`,
 * с пробелами и скобками. Без приведения поиск молча не находил бы ничего.
 *
 * Ненормализуемое не отвергается: у отказа `destination_invalid` в назначении лежат
 * цифры набранного ([ADR-0042](../../../../../docs/adr/0042-diagnoz-po-nerazobrannomu-nomeru.md)),
 * и человек, увидевший в списке вызов на `112`, должен уметь отобрать по нему.
 * Отвергается только набор, в котором нет ни одной цифры: искать было бы нечего.
 */
const destination = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .trim()
    .transform((value, ctx): CallDestination => {
      const normalized = normalizeMsisdn(value);
      if (normalized !== undefined) return normalized;

      const digits = dialledDigits(value);
      if (digits === '') {
        ctx.addIssue({ code: 'custom', message: 'в отборе нет ни одной цифры' });
      }
      return digits;
    })
    .optional(),
);

/** Общая часть отбора: одна и та же у списка и у сводки. */
const callFilterShape = {
  status: optional(z.enum(CALL_STATUSES)),
  failureReason: optional(z.enum(CALL_FAILURE_REASONS)),
  clientId: optional(z.uuid('должен быть идентификатором')),
  channelId: optional(z.uuid('должен быть идентификатором')),
  partnerId: optional(z.uuid('должен быть идентификатором')),
  destination,
  from: moment,
  to: moment,
};

export const callsQuerySchema = z.object({
  ...callFilterShape,
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, CALLS_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

/** Сводка страницами не листается: она отвечает про весь период целиком. */
export const callsSummaryQuerySchema = z.object(callFilterShape);

/**
 * Отбор вызовов в клиентском контуре.
 *
 * Уже административного на три поля, и каждое убрано по своей причине. `clientId` —
 * клиент выводится из сессии, приём параметра означал бы возможность подставить чужой.
 * `partnerId` — партнёры клиенту неразличимы
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 * `failureReason` — клиент видит **переведённый** набор причин
 * (`clientFailureReasonOf`), и отбор по внутреннему значению спрашивал бы о том,
 * чего в его ответах нет.
 */
export const clientCallsQuerySchema = z.object({
  status: callFilterShape.status,
  channelId: callFilterShape.channelId,
  destination: callFilterShape.destination,
  from: callFilterShape.from,
  to: callFilterShape.to,
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, CALLS_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

/**
 * Отбор вызовов в кабинете партнёра.
 *
 * `partnerId` принимается, но решает только у администратора и поддержки: партнёру
 * служба подставляет его самого (`PartnerReportService`). Отбора по клиенту и линии нет:
 * по ним партнёр проверял бы, какие клиенты идут через его железо, а стороны друг друга
 * не видят ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 *
 * Без `limit` отдаются прежние двести последних: так обработчик отвечал до появления
 * страниц, и вызов без параметров должен остаться тем же.
 */
export const partnerCallsQuerySchema = z.object({
  partnerId: callFilterShape.partnerId,
  status: callFilterShape.status,
  from: callFilterShape.from,
  to: callFilterShape.to,
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw ?? String(CALLS_PAGE_MAX), CALLS_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

/**
 * Заведение SIP-транка ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Узел обязателен: к провайдеру регистрируемся мы, и регистрация принадлежит конкретной
 * машине. Транк без узла — это ёмкость, которую некому поднять.
 */
export const createSipTrunkSchema = z
  .object({
    partnerId: z.uuid('должен быть идентификатором'),
    nodeId: z.uuid('должен быть идентификатором'),
    name,

    /** Куда отправлять вызовы: `sip.provider.ru` либо `sip.provider.ru:5070`. */
    proxyHost: z
      .string()
      .trim()
      .min(3, 'слишком короткий')
      .max(200, 'слишком длинный')
      .regex(/^[a-zA-Z0-9.\-_]+(:[0-9]{1,5})?$/u, 'должен быть узлом сети, возможно с портом'),

    /**
     * Регистрируемся ли мы у провайдера. Второй способ — доступ по адресу источника:
     * провайдер узнаёт нас по IP, и регистрация не нужна.
     */
    registersOutbound: z.boolean().default(true),

    outboundUsername: z.string().trim().min(1, 'не может быть пустым').max(200).optional(),
    outboundSecret: z.string().min(1, 'не может быть пустым').max(300).optional(),

    maxConcurrentCalls: z.coerce
      .number()
      .int('должно быть целым числом')
      .min(1, 'ноль каналов означал бы, что звонить нельзя вовсе')
      .max(MAX_TRUNK_CONCURRENT_CALLS, 'неправдоподобно много')
      .default(DEFAULT_TRUNK_CONCURRENT_CALLS),
  })
  .refine(
    (value) =>
      !value.registersOutbound ||
      (value.outboundUsername !== undefined && value.outboundSecret !== undefined),
    {
      // База это тоже проверяет, но отказ базы читается как «нарушено ограничение»,
      // а здесь человек получает названную причину.
      message: 'Для регистрации нужны имя и пароль провайдера',
    },
  );

/**
 * Правка транка. Все поля необязательны, «поля нет» означает «не трогать».
 *
 * Пароль поэтому меняется только явной передачей: правка адреса не должна стирать
 * учётные данные — транк перестал бы подниматься, а причина была бы видна только
 * в логе узла.
 */
export const updateSipTrunkSchema = z
  .object({
    proxyHost: z
      .string()
      .trim()
      .min(3, 'слишком короткий')
      .max(200, 'слишком длинный')
      .regex(/^[a-zA-Z0-9.\-_]+(:[0-9]{1,5})?$/u, 'должен быть узлом сети, возможно с портом')
      .optional(),
    registersOutbound: z.boolean().optional(),
    outboundUsername: z.string().trim().max(200).nullable().optional(),
    outboundSecret: z.string().max(300).nullable().optional(),
    maxConcurrentCalls: z.coerce
      .number()
      .int('должно быть целым числом')
      .min(1, 'ноль каналов означал бы, что звонить нельзя вовсе')
      .max(MAX_TRUNK_CONCURRENT_CALLS, 'неправдоподобно много')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Нечего менять: не передано ни одного поля',
  });

/**
 * Тестовый звонок с SIM ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 * Номер приводится к российскому виду в службе — здесь только разумная длина строки.
 */
export const testCallSchema = z.object({
  destination: z.string().trim().min(1, 'укажите номер').max(32, 'слишком длинный'),
});
