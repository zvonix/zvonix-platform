/**
 * Реестр узлов: человеческая часть (ADR-0009).
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { NodeSetService } from './node-set.service.js';
import type { NodeRow } from './nodes.repository.js';
import type { SipCheck } from './sip-dns.js';
import { NodesService, type ProvisionedNode } from './nodes.service.js';
import { nodeSettingsSchema, provisionNodeSchema, reissueInstallSchema } from './schemas.js';

interface NodeView {
  readonly id: string;
  readonly name: string;
  readonly hostname: string | null;
  readonly sip_address: string | null;
  readonly status: string;
  readonly agent_version: string | null;
  /** Версия набора на узле (ADR-0068); пусто — узел её не присылает. */
  readonly set_version: string | null;
  readonly active_calls: number;
  readonly last_heartbeat_at: string | null;
  readonly created_at: string;
  /** Адрес, с которого узел последний раз обращался к площадке (ADR-0113, ревизия). */
  readonly last_address: string | null;
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
  constructor(
    private readonly nodes: NodesService,
    private readonly nodeSet: NodeSetService,
  ) {}

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
  async list(): Promise<{
    nodes: (NodeView & { sip_check: SipCheckView | null })[];
    current_set_version: string;
  }> {
    const rows = await this.nodes.list();
    // Проверка адреса SIP — у каждого работающего узла, из минутной памяти DNS: строка списка сразу
    // говорит, верна ли запись (ADR-0113, ревизия). У удалённого проверять нечего.
    const nodes = await Promise.all(
      rows.map(async (row) => ({
        ...toNodeView(row),
        sip_check:
          row.status === 'decommissioned' ? null : toSipCheckView(await this.nodes.sipCheckOf(row)),
      })),
    );
    // Версия набора площадки: по ней кабинет отличает актуальный узел от отставшего (ADR-0068).
    return { nodes, current_set_version: await this.nodeSet.version() };
  }

  @Roles('admin', 'support')
  @Get(':id')
  async get(@Param('id') id: string): Promise<{ node: NodeView }> {
    return { node: toNodeView(await this.nodes.get(parseId(id, 'node'))) };
  }

  /**
   * Куда ведёт адрес SIP узла ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md),
   * ревизия): DNS-запись есть ли, туда ли, какую завести. `?address=` — проверить вводимый адрес до сохранения,
   * `?fresh=1` — спросить DNS заново, мимо минутной памяти.
   */
  @Roles('admin', 'support')
  @Get(':id/sip-check')
  async sipCheck(
    @Param('id') id: string,
    @Query('address') address: string | undefined,
    @Query('fresh') fresh: string | undefined,
  ): Promise<{ check: SipCheckView }> {
    const candidate =
      address === undefined
        ? undefined
        : address.trim() === ''
          ? null
          : address.trim().slice(0, 200);
    const check = await this.nodes.sipCheck(parseId(id, 'node'), {
      ...(candidate === undefined ? {} : { candidate }),
      fresh: fresh === '1',
    });
    return { check: toSipCheckView(check) };
  }

  /**
   * Настройки узла: название и адрес SIP ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md)).
   * Пустой адрес — определить по пульсу узла заново.
   */
  @Roles('admin')
  @Post(':id/settings')
  async settings(
    @Param('id') id: string,
    @Body(zodBody(nodeSettingsSchema)) body: z.infer<typeof nodeSettingsSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ node: NodeView }> {
    const updated = await this.nodes.updateSettings(
      parseId(id, 'node'),
      { name: body.name, sipAddress: body.sipAddress },
      actor.userId,
      actor.role,
    );
    return { node: toNodeView(updated) };
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

interface SipCheckView {
  verdict: SipCheck['verdict'];
  address: string | null;
  resolved: readonly string[];
  expected: readonly string[];
  record: SipCheck['record'];
}

function toSipCheckView(check: SipCheck): SipCheckView {
  return {
    verdict: check.verdict,
    address: check.address,
    resolved: check.resolved,
    expected: check.expected,
    record: check.record,
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
    set_version: row.setVersion,
    active_calls: row.activeCalls,
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
    last_address: row.lastAddress,
    created_at: row.createdAt.toISOString(),
  };
}
