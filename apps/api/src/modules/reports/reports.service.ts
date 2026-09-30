/**
 * Период, дополнение пустых суток и итоги над выборкой репозитория
 * ([ADR-0059](../../../../../docs/adr/0059-otchyoty-i-svodki.md)).
 */

import { Injectable } from '@nestjs/common';
import { Money } from '@zvonix/shared';
import {
  ReportsRepository,
  type BreakdownRow,
  type Dimension,
  type Metrics,
  type ReportScope,
  type SeriesRow,
} from './reports.repository.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface Overview {
  readonly days: number;
  readonly from: Date;
  readonly to: Date;
  readonly totals: Metrics;
  readonly series: SeriesRow[];
}

const EMPTY: Metrics = {
  calls: 0,
  answered: 0,
  talkSeconds: 0,
  clientAmount: '0',
  partnerAmount: '0',
  margin: '0',
};

/** Сумма микроединиц строкой: складывать деньги числами нельзя. */
const addMicros = (left: string, right: string): string => String(BigInt(left) + BigInt(right));

const sumMetrics = (rows: readonly Metrics[]): Metrics =>
  rows.reduce<Metrics>(
    (total, row) => ({
      calls: total.calls + row.calls,
      answered: total.answered + row.answered,
      talkSeconds: total.talkSeconds + row.talkSeconds,
      clientAmount: addMicros(total.clientAmount, row.clientAmount),
      partnerAmount: addMicros(total.partnerAmount, row.partnerAmount),
      margin: addMicros(total.margin, row.margin),
    }),
    EMPTY,
  );

/** Микроединицы строкой → сумма в рублях для ответа. */
export const rubles = (micros: string): string => Money.format(Money.fromMicros(BigInt(micros)));

@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}

  /**
   * Границы: последние `days` суток по часовому поясу браузера, включая сегодняшние.
   * Сутки — по местным часам человека: иначе «сегодня» у Красноярска начиналось бы в 7 утра.
   */
  period(days: number, offsetMinutes: number, now = new Date()): { from: Date; to: Date } {
    const local = now.getTime() + offsetMinutes * MINUTE_MS;
    const today = Math.floor(local / DAY_MS) * DAY_MS;
    return {
      from: new Date(today - (days - 1) * DAY_MS - offsetMinutes * MINUTE_MS),
      to: new Date(today + DAY_MS - offsetMinutes * MINUTE_MS),
    };
  }

  async overview(scope: ReportScope, days: number, offsetMinutes: number): Promise<Overview> {
    const { from, to } = this.period(days, offsetMinutes);
    const rows = await this.repository.series(scope, from, to, offsetMinutes);
    const byDay = new Map(rows.map((row) => [row.day, row]));

    // Сутки без вызовов — нули, а не дыра: график с пропусками врёт о масштабе.
    const series: SeriesRow[] = [];
    for (let index = 0; index < days; index += 1) {
      const local = new Date(from.getTime() + index * DAY_MS + offsetMinutes * MINUTE_MS);
      const day = local.toISOString().slice(0, 10);
      series.push(byDay.get(day) ?? { day, ...EMPTY });
    }
    return { days, from, to, totals: sumMetrics(series), series };
  }

  async breakdown(
    scope: ReportScope,
    days: number,
    offsetMinutes: number,
    dimension: Dimension,
  ): Promise<BreakdownRow[]> {
    const { from, to } = this.period(days, offsetMinutes);
    return this.repository.breakdown(scope, from, to, dimension);
  }
}
