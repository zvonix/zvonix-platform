/**
 * Состояние серверов: нагрузка, память, диск и их история
 * ([ADR-0065](../../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)).
 *
 * Два источника замеров: сама площадка (задача воркера раз в минуту) и узлы (`POST /node/metrics`).
 * Читает администратор и поддержка; ничего не меняет, кроме собственных замеров.
 */

import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ServersRepository,
  type MetricDraft,
  type MetricPoint,
  type MetricRow,
  type MetricSource,
} from './servers.repository.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MEGABYTE = 1024 * 1024;

/** Окна графика: за какое время и какими корзинами (до ~700 точек на источник). */
const SERVER_RANGES = {
  hour: { durationMs: 60 * MINUTE_MS, bucketSeconds: 60 },
  day: { durationMs: DAY_MS, bucketSeconds: 300 },
  week: { durationMs: 7 * DAY_MS, bucketSeconds: 1800 },
} as const;
export type ServerRange = keyof typeof SERVER_RANGES;

/** Замер старше этого считается устаревшим: источник молчит, и картина уже не про «сейчас». */
const METRIC_FRESH_MS = 15 * MINUTE_MS;

/** Свободного места меньше этой доли — тревога (ADR-0062, четвёртое условие). */
const LOW_DISK_FRACTION = 0.1;

/** Занято памяти больше этой доли — тревога: дальше сервер начнёт убивать процессы. */
const HIGH_MEMORY_FRACTION = 0.92;

/** Нагрузка выше удвоенного числа ядер, и так все последние минуты, — перегрузка, а не всплеск. */
const OVERLOAD_RATIO = 2;
const OVERLOAD_WINDOW_MINUTES = 10;
/** Замеров в окне не меньше стольких (раз в минуту): иначе «все минуты» — это одна случайная точка. */
const OVERLOAD_MIN_POINTS = 5;

interface ServerSnapshot {
  readonly load1Centi: number;
  readonly cpuCores: number;
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  readonly diskTotalMb: number;
  readonly diskFreeMb: number;
  readonly activeCalls: number | null;
  readonly takenAt: Date;
}

export interface ServerView {
  readonly scope: 'platform' | 'node';
  readonly id: string | null;
  readonly name: string;
  /** Состояние узла; у площадки пусто. */
  readonly status: string | null;
  /** Последнего замера нет или он старше `METRIC_FRESH_MS`. */
  readonly stale: boolean;
  readonly current: ServerSnapshot | null;
  readonly series: readonly MetricPoint[];
}

/** Источник под нагрузкой: память почти кончилась и (или) процессор перегружен несколько минут подряд. */
export interface Strained {
  readonly scope: 'platform' | 'node';
  readonly id: string | null;
  readonly name: string;
  /** Занятая память в процентах; `undefined` — память в порядке. */
  readonly memoryUsedPercent?: number;
  /** Нагрузка в долях от числа ядер (2,5 — на ядро приходится два с половиной процесса); `undefined` — в порядке. */
  readonly loadPerCore?: number;
}

export interface LowDisk {
  readonly scope: 'platform' | 'node';
  readonly id: string | null;
  readonly name: string;
  readonly freeMb: number;
  readonly totalMb: number;
}

const snapshotOf = (row: MetricRow): ServerSnapshot => ({
  load1Centi: row.load1Centi,
  cpuCores: row.cpuCores,
  memTotalMb: row.memTotalMb,
  memAvailableMb: row.memAvailableMb,
  diskTotalMb: row.diskTotalMb,
  diskFreeMb: row.diskFreeMb,
  activeCalls: row.activeCalls,
  takenAt: row.takenAt,
});

@Injectable()
export class ServersService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: ServersRepository,
    private readonly nodes: NodesService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('servers');
  }

  /** Замер от узла по его ключу. Устаревший скрипт замеров просто не присылает. */
  async recordFromNode(
    principal: MachinePrincipal,
    input: {
      load1: number;
      cpuCores: number;
      memTotalMb: number;
      memAvailableMb: number;
      diskTotalMb: number;
      diskFreeMb: number;
      activeCalls?: number | undefined;
    },
    now: Date = new Date(),
  ): Promise<void> {
    const nodeId = parseId(principal.ownerId, 'node');
    await this.repository.insert(nodeId, now, {
      load1Centi: Math.round(input.load1 * 100),
      cpuCores: input.cpuCores,
      memTotalMb: input.memTotalMb,
      memAvailableMb: Math.min(input.memAvailableMb, input.memTotalMb),
      diskTotalMb: input.diskTotalMb,
      diskFreeMb: Math.min(input.diskFreeMb, input.diskTotalMb),
      activeCalls: input.activeCalls ?? null,
    });
  }

  /**
   * Замер самой площадки: нагрузка и память операционной системы, диск каталога записей.
   * Воркер стоит на той же машине, что и API, поэтому замер у него общий.
   */
  async samplePlatform(now: Date = new Date()): Promise<number> {
    const disk = await this.diskOf(this.config.RECORDINGS_DIR);
    const draft: MetricDraft = {
      load1Centi: Math.round((os.loadavg()[0] ?? 0) * 100),
      cpuCores: Math.max(1, os.availableParallelism()),
      memTotalMb: Math.round(os.totalmem() / MEGABYTE),
      memAvailableMb: Math.round(os.freemem() / MEGABYTE),
      diskTotalMb: disk.totalMb,
      diskFreeMb: disk.freeMb,
      activeCalls: null,
    };
    await this.repository.insert(null, now, draft);
    return 1;
  }

  /**
   * Диск, на котором лежит каталог; нет каталога (записи в S3, свежая установка) —
   * диск, на котором работает процесс. Лучше замер соседнего диска, чем отсутствие замера.
   */
  private async diskOf(dir: string): Promise<{ totalMb: number; freeMb: number }> {
    for (const path of [dir, process.cwd()]) {
      try {
        const stats = await statfs(path);
        return {
          totalMb: Math.round((stats.blocks * stats.bsize) / MEGABYTE),
          freeMb: Math.round((stats.bavail * stats.bsize) / MEGABYTE),
        };
      } catch {
        // Следующий вариант.
      }
    }
    this.logger.warn('Диск площадки не измерен', { dir });
    return { totalMb: 0, freeMb: 0 };
  }

  /** Площадка и все действующие узлы: последний замер и история за окно. */
  async overview(range: ServerRange, now: Date = new Date()): Promise<ServerView[]> {
    const window = SERVER_RANGES[range];
    const since = new Date(now.getTime() - window.durationMs);

    const sources: {
      scope: 'platform' | 'node';
      id: MetricSource;
      name: string;
      status: string | null;
    }[] = [{ scope: 'platform', id: null, name: 'Площадка', status: null }];
    for (const node of await this.nodes.list()) {
      if (node.status === 'decommissioned') continue;
      sources.push({ scope: 'node', id: node.id, name: node.name, status: node.status });
    }

    const views: ServerView[] = [];
    for (const source of sources) {
      const latest = await this.repository.latest(source.id);
      const fresh =
        latest !== undefined && now.getTime() - latest.takenAt.getTime() <= METRIC_FRESH_MS;
      views.push({
        scope: source.scope,
        id: source.id,
        name: source.name,
        status: source.status,
        stale: !fresh,
        current: latest === undefined ? null : snapshotOf(latest),
        series: await this.repository.series(source.id, since, window.bucketSeconds),
      });
    }
    return views;
  }

  /** Площадка и действующие узлы: источники замеров. */
  private async sources(): Promise<
    { scope: 'platform' | 'node'; id: MetricSource; name: string }[]
  > {
    const sources: { scope: 'platform' | 'node'; id: MetricSource; name: string }[] = [
      { scope: 'platform', id: null, name: 'Площадка' },
    ];
    for (const node of await this.nodes.list()) {
      if (node.status === 'decommissioned') continue;
      sources.push({ scope: 'node', id: node.id, name: node.name });
    }
    return sources;
  }

  /**
   * Источники под нагрузкой по свежим замерам: память занята почти вся либо процессор перегружен все последние
   * минуты. Один всплеск не тревога — смотрится окно, а не последняя точка.
   */
  async strained(now: Date = new Date()): Promise<Strained[]> {
    const found: Strained[] = [];
    for (const source of await this.sources()) {
      const latest = await this.repository.latest(source.id);
      if (latest === undefined) continue;
      if (now.getTime() - latest.takenAt.getTime() > METRIC_FRESH_MS) continue;

      const memoryUsed = latest.memTotalMb > 0 ? 1 - latest.memAvailableMb / latest.memTotalMb : 0;
      const points = await this.repository.series(
        source.id,
        new Date(now.getTime() - OVERLOAD_WINDOW_MINUTES * MINUTE_MS),
        60,
      );
      const cores = Math.max(latest.cpuCores, 1);
      const overloaded =
        points.length >= OVERLOAD_MIN_POINTS &&
        points.every((point) => point.load1Centi / 100 / cores >= OVERLOAD_RATIO);

      if (memoryUsed < HIGH_MEMORY_FRACTION && !overloaded) continue;
      found.push({
        scope: source.scope,
        id: source.id,
        name: source.name,
        ...(memoryUsed >= HIGH_MEMORY_FRACTION
          ? { memoryUsedPercent: Math.round(memoryUsed * 100) }
          : {}),
        ...(overloaded
          ? {
              loadPerCore:
                points.reduce((sum, point) => sum + point.load1Centi, 0) /
                points.length /
                100 /
                cores,
            }
          : {}),
      });
    }
    return found;
  }

  /** Источники, у которых по свежему замеру мало места на диске. */
  async lowDisk(now: Date = new Date()): Promise<LowDisk[]> {
    const found: LowDisk[] = [];
    for (const source of await this.sources()) {
      const latest = await this.repository.latest(source.id);
      if (latest === undefined || latest.diskTotalMb <= 0) continue;
      if (now.getTime() - latest.takenAt.getTime() > METRIC_FRESH_MS) continue;
      if (latest.diskFreeMb / latest.diskTotalMb >= LOW_DISK_FRACTION) continue;
      found.push({
        scope: source.scope,
        id: source.id,
        name: source.name,
        freeMb: latest.diskFreeMb,
        totalMb: latest.diskTotalMb,
      });
    }
    return found;
  }

  /** Убирает историю старше срока из настроек (ADR-0065); догоняющая: считает по сроку. */
  async purge(now: Date = new Date()): Promise<number> {
    const { metricsDays } = await this.settings.retention();
    return this.repository.purgeBefore(new Date(now.getTime() - metricsDays * DAY_MS));
  }
}
