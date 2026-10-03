/**
 * Состояние серверов ([ADR-0065](../../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)).
 *
 * Читают администратор и поддержка (только чтение); замеры присылает узел по своему ключу.
 */

import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Machine, Roles } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { nodeMetricsSchema, serversQuerySchema } from './schemas.js';
import { ServersService, type ServerView } from './servers.service.js';

interface ServerJson {
  readonly scope: 'platform' | 'node';
  readonly id: string | null;
  readonly name: string;
  readonly status: string | null;
  readonly stale: boolean;
  readonly current: {
    readonly load1: number;
    readonly cpu_cores: number;
    readonly mem_total_mb: number;
    readonly mem_available_mb: number;
    readonly disk_total_mb: number;
    readonly disk_free_mb: number;
    readonly active_calls: number | null;
    readonly taken_at: string;
  } | null;
  readonly series: readonly {
    readonly at: string;
    readonly load1: number;
    readonly mem_available_mb: number;
    readonly disk_free_mb: number;
  }[];
}

function toJson(view: ServerView): ServerJson {
  return {
    scope: view.scope,
    id: view.id,
    name: view.name,
    status: view.status,
    stale: view.stale,
    current:
      view.current === null
        ? null
        : {
            load1: view.current.load1Centi / 100,
            cpu_cores: view.current.cpuCores,
            mem_total_mb: view.current.memTotalMb,
            mem_available_mb: view.current.memAvailableMb,
            disk_total_mb: view.current.diskTotalMb,
            disk_free_mb: view.current.diskFreeMb,
            active_calls: view.current.activeCalls,
            taken_at: view.current.takenAt.toISOString(),
          },
    series: view.series.map((point) => ({
      at: point.at.toISOString(),
      load1: point.load1Centi / 100,
      mem_available_mb: point.memAvailableMb,
      disk_free_mb: point.diskFreeMb,
    })),
  };
}

@Controller()
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  /** Площадка и узлы: последний замер и история за окно (`range`: hour, day, week). */
  @Roles('admin', 'support')
  @Get('servers')
  async overview(
    @Query(zodQuery(serversQuerySchema)) query: z.infer<typeof serversQuerySchema>,
  ): Promise<{ servers: ServerJson[] }> {
    return { servers: (await this.servers.overview(query.range)).map(toJson) };
  }

  /** Замер от узла: раз в минуту, по ключу узла. */
  @Machine('node')
  @Post('node/metrics')
  @HttpCode(204)
  async record(
    @Body(zodBody(nodeMetricsSchema)) body: z.infer<typeof nodeMetricsSchema>,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<void> {
    await this.servers.recordFromNode(machine, body);
  }
}
