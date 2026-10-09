'use client';

import { Hint } from '@/components/hint';
import { LIMIT_WINDOW_NAME } from '@/lib/labels';
import {
  ChangeLimit,
  counted,
  NewTariffLimit,
  RemoveLimit,
  usePartnerLimits,
  type TariffLimit,
} from '@/lib/limits';

/**
 * Лимиты тарифа звонков ([ADR-0080](../../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
 * действуют на каждую карту, которая работает по этому тарифу, у каждой карты счёт свой.
 * Остатки по картам — на странице «Лимиты».
 */
export function TariffLimits({ tariffId }: { tariffId: string }) {
  const limits = usePartnerLimits();
  // Одно правило — одна строка: по картам оно повторяется, а здесь нужен сам лимит.
  const rules = (limits.data?.tariff_limits ?? []).filter((row) => row.tariff_id === tariffId);

  return (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">Лимиты карт</h4>
        <Hint label="Как работают лимиты тарифа">
          <p>
            Лимит действует на каждую карту, которая работает по этому тарифу, и считается у каждой
            карты отдельно. Исчерпавшая лимит карта отдыхает до обнуления, остальные звонят.
          </p>
        </Hint>
        <div className="ml-auto">
          <NewTariffLimit tariffId={tariffId} />
        </div>
      </div>
      {limits.error !== null && (
        <p role="alert" className="text-crit">
          {limits.error.message}
        </p>
      )}
      {limits.data !== undefined && rules.length === 0 && (
        <p className="text-muted-foreground">Лимитов нет — карты звонят без ограничений.</p>
      )}
      {rules.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {counted(row.metric, row.value)} {LIMIT_WINDOW_NAME[row.window]}
          </span>
          <span className="text-faint">{detail(row)}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <ChangeLimit row={row} />
            <RemoveLimit row={row} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Что у лимита сверх числа: «на каждую карту» и «задал партнёр» здесь очевидны, остальное — нет. */
function detail(row: TariffLimit): string {
  const parts: string[] = [];
  if (row.rounding === 'minute') parts.push('поминутно');
  if (row.period_start_day !== null) parts.push(`обновляется ${String(row.period_start_day)}-го`);
  return parts.join(' · ');
}
