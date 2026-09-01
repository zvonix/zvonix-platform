/**
 * Реестр узлов: человеческая часть (ADR-0009).
 */

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import type { NodeRow } from './nodes.repository.js';
import { NodesService, type ProvisionedNode } from './nodes.service.js';
import { provisionNodeSchema, reissueInstallSchema } from './schemas.js';

interface NodeView {
  readonly id: string;
  readonly name: string;
  readonly hostname: string | null;
  readonly sip_address: string | null;
  readonly status: string;
  readonly agent_version: string | null;
  readonly active_calls: number;
  readonly last_heartbeat_at: string | null;
  readonly created_at: string;
}

/**
 * Команда установки.
 *
 * Содержит одноразовый токен в открытом виде — иначе её нельзя выполнить. Показывается
 * администратору один раз; повторно получить ту же команду нельзя, выдаётся новая.
 */
interface InstallView {
  readonly command: string;
  readonly token_expires_at: string | null;
}

@Controller('nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  /**
   * Заводит узел и сразу выдаёт команду установки.
   *
   * Порядок «сначала узел, потом установка» задан ARCHITECTURE.md и отражён в первом
   * состоянии жизненного цикла — `provisioned`: запись есть, машина ещё не отвечает.
   */
  @Roles('admin')
  @Post()
  async provision(
    @Body(zodBody(provisionNodeSchema)) body: z.infer<typeof provisionNodeSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ node: NodeView; install: InstallView }> {
    const provisioned = await this.nodes.provision(
      {
        name: body.name,
        sipAddress: body.sipAddress ?? null,
        allowedIps: body.allowedIps,
      },
      actor.userId,
      actor.role,
    );
    return toProvisionedView(provisioned);
  }

  /**
   * Выдаёт новую команду установки: прежний токен живёт час, а установка откладывается
   * на завтра чаще, чем хотелось бы.
   */
  @Roles('admin')
  @Post(':id/install-command')
  async reissue(
    @Param('id') id: string,
    @Body(zodBody(reissueInstallSchema)) body: z.infer<typeof reissueInstallSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ node: NodeView; install: InstallView }> {
    const provisioned = await this.nodes.reissueInstallCommand(
      parseId(id, 'node'),
      body.allowedIps,
      actor.userId,
      actor.role,
    );
    return toProvisionedView(provisioned);
  }

  @Roles('admin', 'support')
  @Get()
  async list(): Promise<{ nodes: NodeView[] }> {
    const rows = await this.nodes.list();
    return { nodes: rows.map(toNodeView) };
  }

  @Roles('admin', 'support')
  @Get(':id')
  async get(@Param('id') id: string): Promise<{ node: NodeView }> {
    return { node: toNodeView(await this.nodes.get(parseId(id, 'node'))) };
  }

  /**
   * Вывод из эксплуатации: все ключи узла отзываются, запись остаётся.
   *
   * Не `DELETE`, потому что удаления и не происходит: на узел ссылаются CDR,
   * а их не удаляют никогда.
   */
  @Roles('admin')
  @Post(':id/decommission')
  async decommission(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ node: NodeView }> {
    const closed = await this.nodes.decommission(parseId(id, 'node'), actor.userId, actor.role);
    return { node: toNodeView(closed) };
  }
}

function toProvisionedView(provisioned: ProvisionedNode): {
  node: NodeView;
  install: InstallView;
} {
  return {
    node: toNodeView(provisioned.node),
    install: {
      command: provisioned.installCommand,
      token_expires_at: provisioned.tokenExpiresAt?.toISOString() ?? null,
    },
  };
}

function toNodeView(row: NodeRow): NodeView {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    sip_address: row.sipAddress,
    status: row.status,
    agent_version: row.agentVersion,
    active_calls: row.activeCalls,
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
