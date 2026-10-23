/**
 * «Молчащий получатель» ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md), ревизия 2026-10-23):
 * номеру, который подряд не читает сообщения через аккаунты партнёров, аккаунтами не пишем — пауза нарастает ступенями.
 */

/** Доставленное считается непрочитанным только через сутки: свежее человек ещё может прочитать. */
export const UNREAD_AFTER_MS = 86_400_000;

/**
 * Какая ступень паузы набрана серией непрочитанных: `position` — какое по счёту непрочитанное её начало (от момента, когда оно
 * «созрело»), `days` — длина. Порог 0 или серия короче порога — `undefined`, пишем. Третья ступень держится дальше.
 */
export function dormantStep(
  streak: number,
  after: number,
  pauseDays: readonly [number, number, number],
): { readonly position: number; readonly days: number } | undefined {
  if (after <= 0) return undefined;
  const step = Math.floor(streak / after);
  if (step === 0) return undefined;
  return { position: step * after, days: pauseDays[Math.min(step, pauseDays.length) - 1] ?? 0 };
}
