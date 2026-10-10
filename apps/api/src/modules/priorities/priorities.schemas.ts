import { CLIENT_PRIORITY_MAX, CLIENT_PRIORITY_OFFERS } from '@zvonix/shared';
import { z } from 'zod';

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
