'use client';

import { CalendarDays, Check } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { DateRange } from 'react-day-picker';
import { ru } from 'react-day-picker/locale';
import { Segmented } from '@/components/segmented';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { REPORT_PERIODS, type ReportPeriod } from '@/lib/reports';

/** Самый длинный свой период — как у API (`MAX_RANGE_DAYS`). */
const MAX_DAYS = 366;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Местные сутки `ГГГГ-ММ-ДД` — так их ждёт API. */
const isoDay = (date: Date): string =>
  `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** `ГГГГ-ММ-ДД` → местная полночь. */
const fromIsoDay = (day: string): Date => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
};

/** `ГГГГ-ММ-ДД` → `дд.мм.гг`. */
const shortDate = (day: string): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}`;

/** Подпись своего периода на кнопке: «01.11.26 – 17.11.26», один день — одной датой. */
const periodLabel = (period: ReportPeriod): string =>
  'days' in period
    ? (REPORT_PERIODS.find((entry) => entry.days === period.days)?.label ?? '')
    : period.from === period.to
      ? shortDate(period.from)
      : `${shortDate(period.from)} – ${shortDate(period.to)}`;

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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const wide = useWide();
  const custom = !('days' in value);

  const openCalendar = (next: boolean): void => {
    if (next) {
      setDraft(custom ? { from: fromIsoDay(value.from), to: fromIsoDay(value.to) } : undefined);
    }
    setOpen(next);
  };

  const apply = (): void => {
    if (draft?.from === undefined) return;
    const from = isoDay(draft.from);
    onChange({ from, to: isoDay(draft.to ?? draft.from) });
    setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Segmented
        label="Период"
        options={REPORT_PERIODS.map((period) => ({ key: period.days, label: period.label }))}
        value={'days' in value ? value.days : null}
        onChange={(days) => {
          onChange({ days });
        }}
      />
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
            {custom && periodLabel(value)}
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
                : periodLabel({
                    from: isoDay(draft.from),
                    to: isoDay(draft.to ?? draft.from),
                  })}
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
    </div>
  );
}
