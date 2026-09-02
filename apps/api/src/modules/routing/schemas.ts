/**
 * Схемы входных данных маршрутизации (docs/api/node.md).
 */

import { normalizeMsisdn, type Msisdn } from '@zvonix/shared';
import { z } from 'zod';

/**
 * Запрос маршрута от `mod_xml_curl`.
 *
 * Тело — `application/x-www-form-urlencoded`; имена полей заданы FreeSWITCH и потому
 * не в нашем стиле. Проверяются только те, без которых нельзя принять решение: состав
 * переменных меняется от версии к версии, и строгая проверка «лишних полей нет» ломала бы
 * телефонию при обновлении узла.
 */
export const dialplanRequestSchema = z
  .object({
    section: z.literal('dialplan', { error: 'ожидается запрос диалплана' }),

    /** Идентификатор вызова на узле. Он же ключ идемпотентности CDR. */
    'Unique-ID': z.string().trim().min(1, 'не может быть пустым').max(200, 'слишком длинный'),

    /** Номер назначения. */
    'Caller-Destination-Number': z.string().trim().min(1, 'не может быть пустым').max(50),

    /**
     * Канал клиента. Проставляется каталогом на учётную запись SIP, поэтому на узле
     * знания о каналах нет вовсе (docs/api/telephony.md).
     */
    variable_zvonix_channel: z.string().trim().min(1, 'не может быть пустым').max(100),

    hostname: z.string().trim().max(255).optional(),
  })
  .loose();

export const previewSchema = z.object({
  /** Идентификатор разбираемого вызова: задаёт вызывающий, чтобы найти его потом. */
  callId: z.string().trim().min(4, 'слишком короткий').max(200, 'слишком длинный'),
  channelId: z.uuid('должен быть идентификатором'),
  nodeId: z.uuid('должен быть идентификатором'),
  destination: z
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
});
