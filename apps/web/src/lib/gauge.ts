/** Заполненность в процентах: часть от целого, не меньше нуля; целого нет — ноль. */
export const usedPercent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.max(0, Math.round((part / whole) * 100));

/** Цвет заполненности: с девяти десятых — тревога, с трёх четвертей — внимание. */
export function gaugeTone(used: number): string {
  if (used >= 90) return 'bg-crit';
  if (used >= 75) return 'bg-warn';
  return 'bg-ok';
}
