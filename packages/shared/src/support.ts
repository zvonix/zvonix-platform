/**
 * Обращения в поддержку ([ADR-0085](../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

/** Из какого кабинета написано обращение. */
export const TICKET_CABINETS = ['client', 'partner'] as const;
export type TicketCabinet = (typeof TICKET_CABINETS)[number];

/** О чём обращение: по категории сотрудник понимает, к кому идти, ещё не открыв текст. */
export const TICKET_CATEGORIES = [
  'bug',
  'feature',
  'money',
  'messaging',
  'calls',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * Состояния обращения.
 *
 * `open` — ждёт сотрудников; `in_progress` — взято в работу; `waiting_user` — ждём автора;
 * `resolved` — решено (автор может переоткрыть ответом); `closed` — закрыто окончательно.
 */
export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_user',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Чья реплика: автора обращения или сотрудника площадки. */
export const TICKET_SIDES = ['user', 'staff'] as const;
export type TicketSide = (typeof TICKET_SIDES)[number];

export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MAX = 5000;

/** Предел автора: новых обращений и сообщений в сутки и открытых одновременно. */
export const TICKETS_PER_DAY = 10;
export const TICKET_MESSAGES_PER_DAY = 60;
export const TICKETS_OPEN_MAX = 20;

/** Решённое обращение, к которому автор не вернулся за это число суток, закрывается само. */
export const TICKET_AUTOCLOSE_DAYS = 7;
