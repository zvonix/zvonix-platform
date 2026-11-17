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
import { PeriodPicker } from '@/components/period-picker';
import { Segmented } from '@/components/segmented';
import { request } from '@/lib/api';
import { periodQuery, type ReportPeriod } from '@/lib/reports';

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
  /** Операторы, чьи номера сейчас тормозят (ADR-0108). */
  readonly braked_operators: string[];
}

const GROUPS = [
  { key: 'partners', label: 'Партнёры', one: 'Партнёр' },
  { key: 'operators', label: 'Операторы', one: 'Оператор SIM' },
] as const;
type Group = (typeof GROUPS)[number]['key'];

const share = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part * 100) / whole).toFixed(1).replace('.', ',')} %`;

export function Blocks() {
  const [period, setPeriod] = useState<ReportPeriod>({ days: 7 });
  const [group, setGroup] = useState<Group>('partners');
  const report = useQuery({
    queryKey: ['quality', 'blocks', periodQuery(period)],
    queryFn: () => request<BlocksResponse>(`/quality/blocks?${periodQuery(period)}`),
  });
  const rows = report.data?.[group] ?? [];
  const label = GROUPS.find((entry) => entry.key === group)?.one ?? '';
  const braked = new Set(report.data?.braked_operators ?? []);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="blocks-title">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="blocks-title" className="font-semibold">
          Блокировки номеров
        </h2>
        <Segmented
          label="По кому"
          options={GROUPS.map((entry) => ({ key: entry.key, label: entry.label }))}
          value={group}
          onChange={setGroup}
        />
        <PeriodPicker value={period} onChange={setPeriod} />
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
                <TableCell>
                  {row.name}
                  {group === 'operators' && braked.has(row.id) && (
                    <span
                      className="text-warn"
                      title="За 7 суток сняли несколько SIM этого оператора: все его номера звонят реже, пока снятия не уйдут за 7 суток"
                    >
                      {' · '}тормозит
                    </span>
                  )}
                </TableCell>
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
