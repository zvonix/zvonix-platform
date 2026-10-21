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

/** По умолчанию: обращение, на которое поддержка ответила (или решённое) и к которому автор не вернулся за это число суток, закрывается само (настройка `support.autoclose_days`). */
export const TICKET_AUTOCLOSE_DAYS = 7;

/**
 * Картинки в обращениях ([ADR-0089](../../../docs/adr/0089-obrashcheniya-statusy-i-kartinki.md)): тип определяется по первым байтам файла,
 * а не по расширению и заголовку запроса; SVG и прочее не принимаются.
 */
export const TICKET_IMAGE_TYPES = ['png', 'jpeg', 'webp'] as const;
export type TicketImageType = (typeof TICKET_IMAGE_TYPES)[number];
export const TICKET_IMAGE_MIME: Record<TicketImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
export const TICKET_IMAGE_EXTENSION: Record<TicketImageType, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};
export const TICKET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TICKET_IMAGES_PER_MESSAGE = 5;
/** Сколько байт картинок автор или сотрудник может загрузить за сутки. */
export const TICKET_IMAGE_DAILY_BYTES = 20 * 1024 * 1024;

/** Тип картинки по началу файла; `undefined` — это не PNG, JPEG и не WebP. */
export function imageTypeOf(head: Uint8Array): TicketImageType | undefined {
  const at = (index: number): number => head[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  // WebP: «RIFF», четыре байта длины, «WEBP».
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'webp';
  }
  return undefined;
}
