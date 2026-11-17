'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { LiveSwitch } from '@/components/live-switch';
import { Segmented } from '@/components/segmented';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { duration } from '@/lib/format';
import { GATEWAY_STATUS_NAME, SIM_STATUS_NAME } from '@/lib/labels';
import { useLiveInterval } from '@/lib/live';
import { Blocks } from './blocks';
import { Thresholds } from './thresholds';

interface QualityRow {
  readonly subject_id: string;
  readonly subject_name: string;
  readonly subject_status: string;
  readonly partner_name: string;
  readonly attempts: number;
  readonly answered: number;
  readonly network_failures: number;
  /** Доля состоявшихся в десятитысячных: 4210 — это 42,1 %. */
  readonly asr_basis_points: number;
  readonly acd_seconds: number;
}

const WINDOWS = [
  { minutes: 60, label: 'Час' },
  { minutes: 1440, label: 'Сутки' },
  { minutes: 10080, label: 'Неделя' },
  { minutes: 43200, label: 'Месяц' },
] as const;

const KINDS = [
  { kind: 'sims', label: 'SIM', one: 'SIM' },
  { kind: 'gateways', label: 'Шлюзы', one: 'Шлюз' },
] as const;
type Kind = (typeof KINDS)[number]['kind'];

/**
 * Сколько вызовов нужно, чтобы доля о чём-то говорила: три вызова с одним ответом —
 * это не «33 %», а «рано судить».
 */
const ENOUGH_CALLS = 10;
/** Ниже этой доли состоявшихся разговор о качестве стоит начинать (ADR-0027: решает человек). */
const LOW_ASR = 30;

const asrPercent = (row: QualityRow): number => row.asr_basis_points / 100;

const percent = (value: number): string => `${value.toFixed(1).replace('.', ',')} %`;

/** Подпись состояния объекта; неизвестное значение показывается как есть. */
function statusName(kind: Kind, status: string): string {
  const names: Record<string, string> = kind === 'sims' ? SIM_STATUS_NAME : GATEWAY_STATUS_NAME;
  return names[status] ?? status;
}

export default function QualityPage() {
  return (
    <ConsoleShell title="Качество" requireRole={['admin', 'support']}>
      {() => <Quality />}
    </ConsoleShell>
  );
}

function Quality() {
  const [kind, setKind] = useState<Kind>('sims');
  const [minutes, setMinutes] = useState<number>(1440);
  const live = useLiveInterval();

  const list = useQuery({
    queryKey: ['quality', kind, minutes],
    queryFn: async () => {
      const body = await request<Record<Kind, QualityRow[]>>(
        `/quality/${kind}?windowMinutes=${String(minutes)}`,
      );
      return body[kind];
    },
    refetchInterval: live,
  });

  const rows = list.data ?? [];
  const label = KINDS.find((entry) => entry.kind === kind)?.one ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Что смотрим"
          options={KINDS.map((entry) => ({ key: entry.kind, label: entry.label }))}
          value={kind}
          onChange={setKind}
        />
        <Segmented
          label="За какое время"
          options={WINDOWS.map((entry) => ({ key: entry.minutes, label: entry.label }))}
          value={minutes}
          onChange={setMinutes}
        />
        <div className="ml-auto">
          <LiveSwitch />
        </div>
      </div>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">{label}</TableHead>
              <TableHead className="h-8">Партнёр</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Вызовов</TableHead>
              <TableHead className="h-8 text-right">Состоялось</TableHead>
              <TableHead className="h-8 text-right">Доля состоявшихся</TableHead>
              <TableHead className="h-8 text-right">Средний разговор</TableHead>
              <TableHead className="h-8 text-right">Отказов сети</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {list.data?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground">
                  За это время вызовов не было.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => {
              const enough = row.attempts >= ENOUGH_CALLS;
              const low = enough && asrPercent(row) < LOW_ASR;
              return (
                <TableRow key={row.subject_id}>
                  <TableCell className="num">{row.subject_name}</TableCell>
                  <TableCell>{row.partner_name}</TableCell>
                  <TableCell>
                    {row.subject_status === 'active' ? (
                      <span className="text-muted-foreground">
                        {statusName(kind, row.subject_status)}
                      </span>
                    ) : (
                      <span className="rounded-sm bg-warn-soft px-1.5 py-0.5 text-warn">
                        {statusName(kind, row.subject_status)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{row.attempts}</TableCell>
                  <TableCell className="num text-right">{row.answered}</TableCell>
                  <TableCell className={`num text-right ${low ? 'font-semibold text-crit' : ''}`}>
                    {percent(asrPercent(row))}
                    {!enough && <span className="ml-1 text-faint">мало вызовов</span>}
                  </TableCell>
                  <TableCell className="num text-right">
                    {row.answered === 0 ? '—' : duration(row.acd_seconds)}
                  </TableCell>
                  <TableCell
                    className={`num text-right ${row.network_failures > 0 ? 'text-warn' : ''}`}
                  >
                    {row.network_failures}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Blocks />

      <Thresholds />
    </div>
  );
}
