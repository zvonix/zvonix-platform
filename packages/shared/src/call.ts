/**
 * Вызов и резерв средств под него (ADR-0010, DOMAIN.md).
 */

/**
 * Состояние попытки вызова.
 *
 * `routing`   — маршрут запрошен, решение принимается;
 * `ringing`   — узел дозванивается по выданным кандидатам;
 * `answered`  — соединение установлено, идёт разговор;
 * `completed` — разговор завершён нормально. **Тарифицируются только такие**;
 * `failed`    — вызов не состоялся. Причина в `failure_reason`;
 * `no_answer` — не ответили;
 * `busy`      — занято;
 * `cancelled` — вызывающий положил трубку до ответа.
 *
 * Отказ маршрутизации — это тоже вызов, со статусом `failed` и причиной. Иначе
 * на вопрос «почему у клиента не звонит» отвечать нечем: в журнале ничего не остаётся.
 */
export const CALL_STATUSES = [
  'routing',
  'ringing',
  'answered',
  'completed',
  'failed',
  'no_answer',
  'busy',
  'cancelled',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * Состояния, в которых вызов занимает ресурс: SIM и зарезервированные деньги.
 *
 * По ним считается одновременность на SIM. `routing` входит намеренно: между выдачей
 * маршрута и первым гудком проходит время, и если в этот промежуток SIM считается
 * свободной, на неё уйдёт второй вызов.
 */
export const OPEN_CALL_STATUSES: readonly CallStatus[] = ['routing', 'ringing', 'answered'];

export function isOpenCall(status: CallStatus): boolean {
  return OPEN_CALL_STATUSES.includes(status);
}

/** Тарифицируется только завершённый разговор (DOMAIN.md). */
export function isBillableCall(status: CallStatus): boolean {
  return status === 'completed';
}

/**
 * Причина, по которой вызов не состоялся.
 *
 * Значения совпадают с теми, что уходят в переменную `zvonix_reject_reason` на узле
 * и возвращаются обратно в CDR (docs/api/node.md). Абонент видит грубый код SIP,
 * поддержка — точную причину: сообщать звонящему, что у клиента кончились деньги,
 * не следует.
 */
export const CALL_FAILURE_REASONS = [
  /** Канал неизвестен, не активен либо закрыт доступ клиенту. */
  'channel_unknown',
  /** Оператор номера не подтверждён. Гадать запрещено (ADR-0013). */
  'operator_unconfirmed',
  /** Номер в чёрном списке. */
  'destination_blocked',
  /** Нет действующего тарифа партнёра по направлению или правила наценки. */
  'no_tariff',
  /** Овердрафт исчерпан: средств не хватает даже на резерв. */
  'insufficient_funds',
  /** Исчерпано окно лимита. */
  'limit_exceeded',
  /** Нет свободной SIM нужного оператора. */
  'no_sim_available',
  /** Канал требует запись, а подходят только шлюзы, где она невозможна. */
  'recording_required',
  /** Регион номера не покрыт ни одним партнёром. */
  'no_coverage',
  /** Внутренняя неисправность control plane. */
  'internal_error',
] as const;
export type CallFailureReason = (typeof CALL_FAILURE_REASONS)[number];

/**
 * Состояние резерва (ADR-0010).
 *
 * `held`     — средства придержаны на время вызова;
 * `captured` — вызов завершён, списана фактическая сумма;
 * `released` — вызов не состоялся или резерв истёк, средства освобождены.
 *
 * Из `captured` и `released` не возвращаются: резерв закрывается ровно один раз.
 */
export const RESERVATION_STATUSES = ['held', 'captured', 'released'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
