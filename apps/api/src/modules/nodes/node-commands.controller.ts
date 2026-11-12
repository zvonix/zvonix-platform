/**
 * Служба команд узла забирает команды и присылает ответы
 * ([ADR-0115](../../../../../docs/adr/0115-uzel-zabiraet-komandy.md), docs/api/node.md).
 *
 * Формат — `text/plain`, а не JSON: на узле разбирает его shell-скрипт без `jq`. Команда — одна строка,
 * ответ FreeSWITCH — как есть.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validationFailed } from '@zvonix/shared';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { NodeCommandsService } from './node-commands.service.js';

/** Потолок ответа FreeSWITCH, который храним: `+OK <uuid>` или `-ERR <ПРИЧИНА>` — строка, а не выгрузка. */
const MAX_REPLY_CHARS = 4000;

@Controller('node/commands')
export class NodeCommandsController {
  constructor(private readonly commands: NodeCommandsService) {}

  /** Долгий запрос: `200` и две строки (идентификатор, команда) — или `204` через 25 с, если команд нет. */
  @Machine('node')
  @Get()
  async take(
    @CurrentMachine() machine: MachinePrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string | undefined> {
    const taken = await this.commands.take(machine, () => request.raw.socket.destroyed);
    if (taken === undefined) {
      reply.code(204);
      return undefined;
    }
    reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store');
    return `${taken.id}\n${taken.command}\n`;
  }

  /** Ответ FreeSWITCH на взятую команду, `text/plain`. */
  @Machine('node')
  @Post(':id/result')
  @HttpCode(200)
  async result(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ accepted: true }> {
    if (typeof body !== 'string') {
      throw validationFailed('Ответ узла — текст (text/plain)', { details: { field: 'body' } });
    }
    await this.commands.finish(machine, id, body.trim().slice(0, MAX_REPLY_CHARS));
    return { accepted: true };
  }
}
