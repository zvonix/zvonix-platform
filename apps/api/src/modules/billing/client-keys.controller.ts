/**
 * Ключи клиентского API так, как ими распоряжается **сам клиент**
 * ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)).
 *
 * Лежит в `billing`, а не в `machine`, по направлению зависимостей: «чей это клиент»
 * знает только этот модуль, и обратная стрелка замкнула бы модули в кольцо.
 *
 * Клиент выводится из сессии, а не принимается параметром: административный выпуск
 * начинается с `clientId` в теле, и открыть его роли `client` значило бы разрешить
 * подставить чужой.
 *
 * Секрет возвращается **здесь и один раз** — там же, где клиент вставит его в свою
 * систему. Пока ключ выпускал администратор, секрет обязан был дойти до клиента
 * перепиской: тот же довод, что и с паролем SIP в контуре партнёра
 * ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseId, type MachineKeyKind } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { ownClientKeySchema } from '../machine/schemas.js';
import { MachineService } from '../machine/machine.service.js';
import type { MachineKeyRow } from '../machine/machine.repository.js';
import { BillingService } from './billing.service.js';

/**
 * Ключ в ответе клиенту.
 *
 * Секрета нет: он существует только в ответе на выпуск. Отозванные тоже отдаются —
 * по ним разбирают, чем ходила система месяц назад.
 */
interface ClientKeyView {
  readonly id: string;
  readonly key_id: string;
  readonly kind: MachineKeyKind;
  readonly label: string;
  readonly allowed_ips: readonly string[];
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

/** Выпущенный ключ вместе с секретом. Второй раз этот ответ получить неоткуда. */
interface IssuedClientKeyView {
  readonly id: string;
  readonly key_id: string;
  readonly secret: string;
  readonly expires_at: string | null;
}

@Controller()
export class ClientKeysController {
  constructor(
    private readonly machine: MachineService,
    private readonly billing: BillingService,
  ) {}

  @Cabinets('client')
  @Get('client/api-keys')
  async list(@CurrentUser() actor: Principal): Promise<{ keys: ClientKeyView[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const rows = await this.machine.listOwnClientKeys(client.id);
    return { keys: rows.map(toClientKeyView) };
  }

  @Cabinets('client')
  @Post('client/api-keys')
  async issue(
    @Body(zodBody(ownClientKeySchema)) body: z.infer<typeof ownClientKeySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ key: IssuedClientKeyView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const issued = await this.machine.issueOwnClientKey({
      clientId: client.id,
      label: body.label,
      allowedIps: body.allowedIps,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });

    return {
      key: {
        id: issued.credentialId,
        key_id: issued.keyId,
        secret: issued.secret,
        expires_at: issued.expiresAt?.toISOString() ?? null,
      },
    };
  }

  /** Отзыв пометкой, а не удалением: иначе в журнале дыра там, где нужно разбираться. */
  @Cabinets('client')
  @Delete('client/api-keys/:id')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @CurrentUser() actor: Principal): Promise<void> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    await this.machine.revokeOwnClientKey(
      parseId(id, 'machineCredential'),
      client.id,
      actor.userId,
      actor.role,
    );
  }
}

function toClientKeyView(row: MachineKeyRow): ClientKeyView {
  return {
    id: row.id,
    key_id: row.keyId,
    kind: row.kind,
    label: row.label,
    allowed_ips: row.allowedIps,
    expires_at: row.expiresAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
