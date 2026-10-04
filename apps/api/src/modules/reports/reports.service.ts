/**
 * Период, дополнение пустых суток и итоги над выборкой репозитория
 * ([ADR-0059](../../../../../docs/adr/0059-otchyoty-i-svodki.md)).
 */

import { Injectable } from '@nestjs/common';
import { Money, validationFailed } from '@zvonix/shared';
import {
  ReportsRepository,
  type AccountOwner,
  type BreakdownRow,
  type Dimension,
  type Metrics,
  type MovementRow,
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

/** Акт или выписка за календарный месяц ([ADR-0069](../../../../../docs/adr/0069-akt-i-vypiska-za-mesyac.md)). */
export interface Statement {
  readonly month: string;
  readonly from: Date;
  readonly to: Date;
  /** Месяц ещё не закончился: итоги и конечный остаток — на сейчас. */
  readonly partial: boolean;
  readonly totals: Metrics;
  /** Только сутки, в которые были вызовы. */
  readonly series: SeriesRow[];
  readonly breakdowns: Partial<Record<Dimension, BreakdownRow[]>>;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly movements: MovementRow[];
  /** Сумма проводок-списаний за вызовы за период, в знаке книги. */
  readonly charges: string;
  /** Сообщения MAX: списано и возвращено, в знаке книги ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)). */
  readonly messageCharges: string;
  readonly messageRefunds: string;
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

  /** Границы календарного месяца `ГГГГ-ММ` по местному времени человека. */
  monthBounds(month: string, offsetMinutes: number): { from: Date; to: Date } {
    const [year, number] = month.split('-').map(Number) as [number, number];
    return {
      from: new Date(Date.UTC(year, number - 1, 1) - offsetMinutes * MINUTE_MS),
      to: new Date(Date.UTC(year, number, 1) - offsetMinutes * MINUTE_MS),
    };
  }

  /**
   * Акт клиента или выписка партнёра за месяц. Разрезы зависят от того, чей это документ;
   * остаток на начало и конец берётся из книги проводок, а не выводится из вызовов.
   */
  async statement(
    scope: Exclude<ReportScope, { kind: 'all' }>,
    month: string,
    offsetMinutes: number,
    now = new Date(),
  ): Promise<Statement> {
    const { from, to } = this.monthBounds(month, offsetMinutes);
    if (from.getTime() > now.getTime()) throw validationFailed('Этот месяц ещё не начался');

    const owner: AccountOwner =
      scope.kind === 'client'
        ? { kind: 'client', id: scope.clientId }
        : { kind: 'partner', id: scope.partnerId };
    const dimensions: readonly Dimension[] =
      scope.kind === 'client' ? ['operator', 'channel'] : ['operator', 'gateway', 'sim'];

    const [series, openingBalance, closingBalance, moved, ...grouped] = await Promise.all([
      this.repository.series(scope, from, to, offsetMinutes),
      this.repository.balanceAt(owner, from),
      this.repository.balanceAt(owner, to),
      this.repository.movements(owner, from, to),
      ...dimensions.map((dimension) => this.repository.breakdown(scope, from, to, dimension)),
    ]);

    return {
      month,
      from,
      to,
      partial: to.getTime() > now.getTime(),
      totals: sumMetrics(series),
      series,
      breakdowns: Object.fromEntries(dimensions.map((dimension, i) => [dimension, grouped[i]])),
      openingBalance,
      closingBalance,
      movements: moved.rows,
      charges: moved.charges,
      messageCharges: moved.messageCharges,
      messageRefunds: moved.messageRefunds,
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
