/**
 * Платежи клиентов: пополнение счёта ([ADR-0064](../../../docs/adr/0064-platezhi-karkas.md)).
 */

/**
 * Способ пополнения. Сейчас один — `manual`: клиент переводит деньги по реквизитам, а
 * администратор подтверждает поступление. Платёжные системы добавляются сюда и в
 * `PaymentProvider` на стороне API; значение попадает в ограничение CHECK, поэтому
 * новое значение — это миграция.
 */
export const PAYMENT_PROVIDERS = ['manual'] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

/**
 * Состояния платежа.
 *
 * `pending`   — заявка создана, денег на счёте ещё нет;
 * `succeeded` — деньги зачислены проводкой. Окончательно;
 * `rejected`  — отклонена администратором (деньги не пришли или не те). Окончательно;
 * `cancelled` — отозвана самим клиентом, пока была `pending`. Окончательно.
 */
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'rejected', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Не больше открытых заявок у одного клиента: заявка без оплаты не должна копиться. */
export const PAYMENT_PENDING_MAX = 5;

/** Границы суммы одной заявки, в рублях: ниже — не стоит перевода, выше — спрашивайте администратора. */
export const PAYMENT_MIN_RUBLES = 100;
export const PAYMENT_MAX_RUBLES = 1_000_000;
