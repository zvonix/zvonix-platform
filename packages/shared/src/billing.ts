/**
 * Перечисления биллинга (ADR-0010).
 */

/**
 * Вид счёта.
 *
 * Кроме счетов клиентов и партнёров есть три системных, и без них двойная запись
 * не сходится: у каждой проводки должна быть вторая сторона.
 *
 * `revenue`    — комиссия платформы;
 * `payable`    — обязательства перед партнёрами: деньги начислены, но не выплачены;
 * `settlement` — шлюз платежей: через него деньги входят в систему и выходят из неё.
 */
export const ACCOUNT_KINDS = ['client', 'partner', 'revenue', 'payable', 'settlement'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Системные счета существуют в единственном экземпляре и не принадлежат никому. */
export const SYSTEM_ACCOUNT_KINDS: readonly AccountKind[] = ['revenue', 'payable', 'settlement'];

export function isSystemAccountKind(kind: AccountKind): boolean {
  return SYSTEM_ACCOUNT_KINDS.includes(kind);
}

/**
 * Что породило движение денег.
 *
 * Записывается у операции целиком, а не у отдельной проводки: проводки одной операции
 * всегда об одном и том же событии, и разные типы внутри неё означали бы ошибку.
 *
 * `deposit`    — пополнение баланса клиента;
 * `charge`     — списание за вызов: клиент платит, партнёр зарабатывает, платформа удерживает;
 * `payout`     — выплата партнёру;
 * `correction` — исправление ошибки обратной проводкой. Правка существующей запрещена.
 */
export const TRANSACTION_KINDS = ['deposit', 'charge', 'payout', 'correction'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Состояние клиента. Неактивный не звонит, но его деньги и история остаются. */
export const CLIENT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * Состояние партнёра.
 *
 * `pending`  — заявка подана, модерация не пройдена;
 * `verified` — проверен, может принимать вызовы;
 * `suspended`— временно отключён, расчёты продолжаются;
 * `closed`   — закрыт; закрывается только при нулевых обязательствах.
 */
export const PARTNER_STATUSES = ['pending', 'verified', 'suspended', 'closed'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
