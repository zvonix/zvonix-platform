/**
 * Машинная часть реестра узлов: регистрация и heartbeat (ADR-0019, docs/api/node.md).
 *
 * Оба обработчика вызывает агент узла — наш собственный бинарник, а не FreeSWITCH.
 * Поэтому здесь обычный JSON, а не form-encoded, и заголовок в виде `Bearer`
 * тоже доступен.
 */

import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { NODE_HEARTBEAT_INTERVAL_MS } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { NodesService } from './nodes.service.js';
import { enrollNodeSchema, heartbeatSchema } from './schemas.js';

@Controller('node')
export class NodeAgentController {
  constructor(private readonly nodes: NodesService) {}

  /**
   * Обмен одноразового токена установки на постоянный ключ.
   *
   * Единственный обработчик, принимающий токен установки, — поэтому вид ключа назван
   * явно. Рабочим ключом этот токен не является и никуда больше не проходит.
   *
   * Ответ содержит секрет постоянного ключа: другого способа передать его на узел нет.
   * Токен при этом расходуется, и повторный вызов той же командой вернёт `409`.
   */
  @Machine('enrollment')
  @Post('enroll')
  @HttpCode(200)
  async enroll(
    @Body(zodBody(enrollNodeSchema)) body: z.infer<typeof enrollNodeSchema>,
    @CurrentMachine() machine: MachinePrincipal,
    @Ip() ip: string,
  ): Promise<{
    node: { id: string; name: string; hostname: string | null; status: string };
    key: { key_id: string; secret: string };
    endpoints: Readonly<Record<string, string>>;
  }> {
    const enrolled = await this.nodes.enroll(machine, body.hostname, body.agentVersion ?? null, ip);

    return {
      // `hostname` возвращается, чтобы скрипт установки видел, что control plane
      // записал именно присланное имя: дальше по нему сверяются запросы маршрута.
      node: {
        id: enrolled.node.id,
        name: enrolled.node.name,
        hostname: enrolled.node.hostname,
        status: enrolled.node.status,
      },
      key: { key_id: enrolled.keyId, secret: enrolled.secret },
      endpoints: enrolled.endpoints,
    };
  }

  /**
   * Heartbeat агента.
   *
   * Отвечает интервалом, который control plane считает нормальным: агент не должен
   * знать его из своей конфигурации — иначе изменение порога требует раскатки на узлы.
   */
  @Machine('node')
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Body(zodBody(heartbeatSchema)) body: z.infer<typeof heartbeatSchema>,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ status: string; next_heartbeat_in_ms: number }> {
    const node = await this.nodes.heartbeat(machine, {
      activeCalls: body.activeCalls,
      agentVersion: body.agentVersion ?? null,
      degraded: body.degraded,
    });

    return { status: node.status, next_heartbeat_in_ms: NODE_HEARTBEAT_INTERVAL_MS };
  }
}
