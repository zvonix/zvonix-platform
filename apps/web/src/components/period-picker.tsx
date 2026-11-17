'use client';

import { CalendarDays, Check } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { DateRange } from 'react-day-picker';
import { ru } from 'react-day-picker/locale';
import { Segmented } from '@/components/segmented';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fromIsoDay, isoDay, REPORT_PERIODS, type ReportPeriod } from '@/lib/reports';

/** Самый длинный свой период — как у API (`MAX_RANGE_DAYS`). */
const MAX_DAYS = 366;

/** `ГГГГ-ММ-ДД` → `дд.мм.гг`. */
const shortDate = (day: string): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}`;

/** Подпись своего периода на кнопке: «01.11.26 – 17.11.26», один день — одной датой. */
const rangeLabel = (from: string, to: string): string =>
  from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;

/** Быстрый период: сколько суток (у графиков серверов бывает и доля суток — час) и подпись кнопки. */
export interface PeriodPreset {
  readonly days: number;
  readonly label: string;
}

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
  presets = REPORT_PERIODS,
}: {
  value: ReportPeriod;
  onChange: (period: ReportPeriod) => void;
  /** Быстрые кнопки; по умолчанию — как у сводки: сегодня, 7, 30, 90 дней. */
  presets?: readonly PeriodPreset[];
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
        options={presets.map((period) => ({ key: period.days, label: period.label }))}
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
    </div>
  );
}
