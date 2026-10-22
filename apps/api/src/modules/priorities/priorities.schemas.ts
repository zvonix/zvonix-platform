import { CLIENT_PRIORITY_MAX, CLIENT_PRIORITY_OFFERS, TERMINATION_KINDS } from '@zvonix/shared';
import { z } from 'zod';
import { amount } from '../billing/schemas.js';

/** Список приоритетов клиента целиком: партнёр (псевдоним), предложение, цифра или `null` — «не использовать». */
export const clientPrioritiesSchema = z.object({
  priorities: z
    .array(
      z.object({
        aliasId: z.uuid('должен быть идентификатором'),
        offer: z.enum(CLIENT_PRIORITY_OFFERS),
        priority: z
          .number()
          .int('должно быть целым числом')
          .min(1, 'от 1')
          .max(CLIENT_PRIORITY_MAX, `до ${String(CLIENT_PRIORITY_MAX)}`)
          .nullable(),
      }),
    )
    .max(2000, 'неправдоподобно много'),
});

/** Какие предложения входят в какой список: звонки — SIM и транк, сообщения — MAX. */
export const PRODUCT_OFFERS = {
  calls: ['sim', 'sip'],
  messages: ['message'],
} as const;

export const productSchema = z.enum(['calls', 'messages']);

/** Требования клиента к партнёрам для звонков (ADR-0095); `null` — без ограничения. */
export const callRequirementsSchema = z.object({
  terminationKind: z.enum(TERMINATION_KINDS).nullable(),
  noRecordingListeners: z.boolean(),
  /** Стоимость вызова в 60 секунд для клиента не дороже. */
  maxPrice: amount.refine((value) => value > 0n, 'должна быть больше нуля').nullable(),
});
