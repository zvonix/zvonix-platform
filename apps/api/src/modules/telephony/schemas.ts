/**
 * Схемы входных данных телефонии (ADR-0009).
 */

import { GATEWAY_TYPES, GATEWAY_STATUSES, CHANNEL_STATUSES } from '@zvonix/shared';
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
