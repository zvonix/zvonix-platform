/**
 * Схемы входных данных обращений ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

import {
  TICKET_BODY_MAX,
  TICKET_CABINETS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
} from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

const body = z
  .string()
  .trim()
  .min(3, 'слишком короткое')
  .max(TICKET_BODY_MAX, `не длиннее ${String(TICKET_BODY_MAX)} знаков`);

export const createTicketSchema = z.object({
  cabinet: z.enum(TICKET_CABINETS),
  subject: z
    .string()
    .trim()
    .min(3, 'слишком короткая')
    .max(TICKET_SUBJECT_MAX, `не длиннее ${String(TICKET_SUBJECT_MAX)} знаков`),
  category: z.enum(TICKET_CATEGORIES),
  body,
});

export const ticketMessageSchema = z.object({ body });

/** Ответ сотрудника: реплика автору либо заметка для своих. */
export const staffMessageSchema = z.object({
  body,
  internal: z.boolean().optional().default(false),
});

export const ticketStatusSchema = z.object({ status: z.enum(TICKET_STATUSES) });

/** `me` — взять на себя, `null` — снять исполнителя. */
export const ticketAssigneeSchema = z.object({ assignee: z.enum(['me']).nullable() });

/** Пустое значение параметра — «любое»: форма отбора шлёт все свои поля. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const ticketsQuerySchema = z.object({
  status: optional(z.enum(TICKET_STATUSES)),
  cabinet: optional(z.enum(TICKET_CABINETS)),
  category: optional(z.enum(TICKET_CATEGORIES)),
  unassigned: optional(z.enum(['1'])),
  q: optional(z.string().trim().max(100)),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, 200)),
  offset: z.string().optional().transform(boundedOffset),
});
