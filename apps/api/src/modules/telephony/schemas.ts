/**
 * Схемы входных данных телефонии (ADR-0009).
 */

import {
  CHANNEL_STATUSES,
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  MAX_CONCURRENT_CALLS_LIMIT,
  normalizeMsisdn,
  SIM_STATUSES,
  type Msisdn,
} from '@zvonix/shared';
import { z } from 'zod';

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
    .max(256, 'неправдоподобно много')
    .default(0),
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
   * номеру SIM: подтверждённое расхождение — отказ, а не предупреждение.
   */
  operatorId: z.uuid('должен быть идентификатором'),

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

export const addPortSchema = z.object({
  /** Номер порта на устройстве, как он подписан на корпусе. */
  portNumber: z.coerce
    .number()
    .int('должен быть целым числом')
    .min(1, 'нумерация портов начинается с единицы')
    .max(256, 'неправдоподобно много'),
});

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
