'use client';

import { CalendarDays, Check } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { DateRange } from 'react-day-picker';
import { ru } from 'react-day-picker/locale';
import { Segmented } from '@/components/segmented';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  fromQuickKey,
  LIST_PERIODS,
  quickKey,
  type ListPeriod,
  type QuickPeriod,
} from '@/lib/list-period';
import { fromIsoDay, isoDay, REPORT_PERIODS, type ReportPeriod } from '@/lib/reports';

/** Самый длинный свой период — как у API (`MAX_RANGE_DAYS`). */
const MAX_DAYS = 366;

/** `ГГГГ-ММ-ДД` → `дд.мм.гг`. */
const shortDate = (day: string): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}`;

/** Подпись своего периода на кнопке: «01.11.26 – 17.11.26», один день — одной датой. */
const rangeLabel = (from: string, to: string): string =>
  from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;

const WIDE = '(min-width: 640px)';

/** Два месяца рядом — на широком экране, на телефоне — один. */
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', notify);
      return () => {
        query.removeEventListener('change', notify);
      };
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * Выбор периода отчёта: быстрые кнопки и свой диапазон в календаре (ADR-0059, ревизия
 * 2026-11-17). Один на все сводки и графики — чтобы период везде выбирался одинаково.
 */
export function PeriodPicker({
  value,
  onChange,
}: {
  value: ReportPeriod;
  onChange: (period: ReportPeriod) => void;
}) {
  const wide = useWide();
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
      <Segmented
        label="Период"
        options={REPORT_PERIODS.map((period) => ({
          key: period.days,
          // На телефоне — «30 д»: весь набор и календарь в одну строку.
          label: wide ? period.label : period.short,
        }))}
        compact={!wide}
        value={'days' in value ? value.days : null}
        onChange={(days) => {
          onChange({ days });
        }}
      />
      <RangeButton value={'days' in value ? undefined : value} wide={wide} onApply={onChange} />
    </div>
  );
}

/**
 * Тот же выбор периода для отбора списков (`lib/list-period.ts`): «Всё время» первым и по умолчанию, у разбора
 * вызовов ещё «Час» и «Сутки» — последние 60 минут и 24 часа. Свой диапазон — тем же календарём, целыми сутками.
 */
export function ListPeriodPicker({
  value,
  onChange,
  options = LIST_PERIODS,
}: {
  value: ListPeriod;
  onChange: (period: ListPeriod) => void;
  options?: readonly QuickPeriod[];
}) {
  const wide = useWide();
  const key = quickKey(value);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Segmented
        label="Период"
        options={options.map((option) => ({
          key: option.key,
          label: wide ? option.label : option.short,
        }))}
        compact={!wide}
        value={key}
        onChange={(next) => {
          onChange(fromQuickKey(next));
        }}
      />
      <RangeButton
        value={key === null ? (value as { from: string; to: string }) : undefined}
        wide={wide}
        onApply={onChange}
      />
    </div>
  );
}

/** Кнопка своего периода с календарём — одна на оба выбора. `value` — свой период, если выбран он. */
function RangeButton({
  value,
  wide,
  onApply,
}: {
  value: { from: string; to: string } | undefined;
  wide: boolean;
  onApply: (period: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const custom = value !== undefined;

  const openCalendar = (next: boolean): void => {
    if (next) {
      setDraft(
        value === undefined
          ? undefined
          : { from: fromIsoDay(value.from), to: fromIsoDay(value.to) },
      );
    }
    setOpen(next);
  };

  const apply = (): void => {
    if (draft?.from === undefined) return;
    const from = isoDay(draft.from);
    onApply({ from, to: isoDay(draft.to ?? draft.from) });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={openCalendar}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={custom ? 'sm' : 'icon-sm'}
          aria-label="Свой период"
          title="Свой период"
          aria-pressed={custom}
          className={custom ? 'num font-semibold' : 'text-muted-foreground'}
        >
          <CalendarDays />
          {custom && rangeLabel(value.from, value.to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="range"
          locale={ru}
          numberOfMonths={wide ? 2 : 1}
          defaultMonth={
            draft?.from ??
            new Date(new Date().getFullYear(), new Date().getMonth() - (wide ? 1 : 0), 1)
          }
          selected={draft}
          onSelect={setDraft}
          resetOnSelect
          max={MAX_DAYS}
          disabled={{ after: new Date() }}
          className="bg-popover"
        />
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
          <span className="num text-muted-foreground">
            {draft?.from === undefined
              ? 'Выберите начало и конец'
              : rangeLabel(isoDay(draft.from), isoDay(draft.to ?? draft.from))}
          </span>
          <Button
            size="icon-sm"
            aria-label="Показать за этот период"
            title="Показать за этот период"
            disabled={draft?.from === undefined}
            onClick={apply}
          >
            <Check />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
