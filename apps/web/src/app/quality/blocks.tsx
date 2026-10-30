'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';

/**
 * Отчёт блокировок ([ADR-0107](../../../../../docs/adr/0107-son-nomera-plokhoy-nomer-i-otchyot-blokirovok.md)): сколько
 * SIM и шлюзов снял порог отказов на 1000 попыток — по партнёрам и по операторам. По нему поднимают или снижают
 * пределы номеров в «Настройки площадки» → «Звонки».
 */

interface BlocksRow {
  readonly id: string;
  readonly name: string;
  readonly attempts: number;
  readonly real_answered: number;
  readonly short_answered: number;
  readonly sims_suspended: number;
  readonly gateways_suspended: number;
  readonly per_thousand: number | null;
}

interface BlocksResponse {
  readonly days: number;
  readonly partners: BlocksRow[];
  readonly operators: BlocksRow[];
}

const PERIODS = [
  { days: 7, label: 'Неделя' },
  { days: 30, label: 'Месяц' },
] as const;

const GROUPS = [
  { key: 'partners', label: 'Партнёры', one: 'Партнёр' },
  { key: 'operators', label: 'Операторы', one: 'Оператор SIM' },
] as const;
type Group = (typeof GROUPS)[number]['key'];

const TOGGLE_ON = 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]';
const TOGGLE_OFF = 'text-muted-foreground hover:text-foreground';

const share = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part * 100) / whole).toFixed(1).replace('.', ',')} %`;

export function Blocks() {
  const [days, setDays] = useState<number>(7);
  const [group, setGroup] = useState<Group>('partners');
  const report = useQuery({
    queryKey: ['quality', 'blocks', days],
    queryFn: () => request<BlocksResponse>(`/quality/blocks?days=${String(days)}`),
  });
  const rows = report.data?.[group] ?? [];
  const label = GROUPS.find((entry) => entry.key === group)?.one ?? '';

  return (
    <section className="flex flex-col gap-3" aria-labelledby="blocks-title">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="blocks-title" className="font-semibold">
          Блокировки номеров
        </h2>
        <div
          className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="По кому"
        >
          {GROUPS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={group === entry.key}
              onClick={() => {
                setGroup(entry.key);
              }}
              className={`rounded px-2.5 py-1.5 ${group === entry.key ? TOGGLE_ON : TOGGLE_OFF}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div
          className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="За какой срок"
        >
          {PERIODS.map((entry) => (
            <button
              key={entry.days}
              type="button"
              aria-pressed={days === entry.days}
              onClick={() => {
                setDays(entry.days);
              }}
              className={`rounded px-2.5 py-1.5 ${days === entry.days ? TOGGLE_ON : TOGGLE_OFF}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {report.error !== null && (
        <p role="alert" className="text-crit">
          {report.error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">{label}</TableHead>
              <TableHead className="h-8 text-right">Попыток</TableHead>
              <TableHead
                className="h-8 text-right"
                title="Разговор от 5 секунд: короче оператор видит как недозвон"
              >
                Ответов
              </TableHead>
              <TableHead className="h-8 text-right" title="Ответили, но разговор короче 5 секунд">
                Коротких
              </TableHead>
              <TableHead className="h-8 text-right">Снято SIM</TableHead>
              <TableHead className="h-8 text-right">Снято шлюзов</TableHead>
              <TableHead
                className="h-8 text-right"
                title="Снятых порогом отказов SIM и шлюзов на 1000 попыток; при меньше 100 попыток — рано судить"
              >
                На 1000 попыток
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {report.data !== undefined && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="text-muted-foreground">
                  За это время вызовов и снятий не было.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell className="num text-right">{row.attempts}</TableCell>
                <TableCell className="num text-right">
                  {share(row.real_answered, row.attempts)}
                </TableCell>
                <TableCell className="num text-right">
                  {share(row.short_answered, row.attempts)}
                </TableCell>
                <TableCell
                  className={`num text-right ${row.sims_suspended > 0 ? 'text-warn' : ''}`}
                >
                  {row.sims_suspended}
                </TableCell>
                <TableCell
                  className={`num text-right ${row.gateways_suspended > 0 ? 'text-warn' : ''}`}
                >
                  {group === 'operators' ? '—' : row.gateways_suspended}
                </TableCell>
                <TableCell
                  className={`num text-right ${row.per_thousand !== null && row.per_thousand > 0 ? 'font-semibold text-crit' : ''}`}
                >
                  {row.per_thousand === null ? '—' : row.per_thousand.toFixed(1).replace('.', ',')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
