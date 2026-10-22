/**
 * Схемы входных данных обращений ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

import {
  TICKET_BODY_MAX,
  TICKET_CABINETS,
  TICKET_CATEGORIES,
  TICKET_IMAGES_PER_MESSAGE,
  TICKET_SCOPES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
} from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

/** Идентификаторы загруженных картинок (ADR-0089): не больше пяти на сообщение. */
const attachments = z.array(z.uuid()).max(TICKET_IMAGES_PER_MESSAGE).optional();

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
  attachments,
});

export const ticketMessageSchema = z.object({ body, attachments });

/** Ответ сотрудника: реплика автору либо заметка для своих. */
export const staffMessageSchema = z.object({
  body,
  internal: z.boolean().optional().default(false),
  attachments,
});

export const ticketStatusSchema = z.object({ status: z.enum(TICKET_STATUSES) });

/** `me` — взять на себя, `null` — снять исполнителя. */
export const ticketAssigneeSchema = z.object({ assignee: z.enum(['me']).nullable() });

/** Пустое значение параметра — «любое»: форма отбора шлёт все свои поля. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const ticketsQuerySchema = z.object({
  status: optional(z.enum(TICKET_STATUSES)),
  scope: optional(z.enum(TICKET_SCOPES)),
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
