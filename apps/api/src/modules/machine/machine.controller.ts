/**
 * Выпуск и отзыв машинных ключей (ADR-0019).
 *
 * Обработчики человеческие: ключи выпускает и отзывает администратор. Сами машины
 * своими ключами не распоряжаются — иначе украденный ключ выпускает себе замену.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { parseId, validationFailed, type MachineKeyKind } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { MachineService } from './machine.service.js';
import { issueClientKeySchema, issueEnrollmentSchema, issueNodeKeySchema } from './schemas.js';

/**
 * Ключ в ответе на выпуск.
 *
 * `secret` присутствует **только здесь и только один раз**: в базе лежит его SHA-256,
 * и восстановить его неоткуда. Потерян — выпускается новый, старый отзывается.
 */
interface IssuedKeyView {
  readonly credential_id: string;
  readonly key_id: string;
  readonly secret: string;
  readonly expires_at: string | null;
}

/** Ключ в списке. Секрета здесь нет и быть не может. */
interface KeyView {
  readonly credential_id: string;
  readonly key_id: string;
  readonly kind: string;
  readonly owner_id: string | null;
  readonly label: string;
  readonly allowed_ips: readonly string[];
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  /**
   * Возраст в сутках. У ключей узлов срока нет намеренно, поэтому «этому ключу 400 дней»
   * должно быть видно заранее, а не наступать внезапно (ADR-0019).
   */
  readonly age_days: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Controller('machine-keys')
export class MachineController {
  constructor(private readonly machine: MachineService) {}

  @Roles('admin')
  @Post('nodes')
  async issueNodeKey(
    @Body(zodBody(issueNodeKeySchema)) body: z.infer<typeof issueNodeKeySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ key: IssuedKeyView }> {
    const issued = await this.machine.issue({
      kind: 'node',
      ownerId: body.nodeId,
      label: body.label,
      allowedIps: body.allowedIps,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return { key: toIssuedView(issued) };
  }

  @Roles('admin')
  @Post('clients')
  async issueClientKey(
    @Body(zodBody(issueClientKeySchema)) body: z.infer<typeof issueClientKeySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ key: IssuedKeyView }> {
    const issued = await this.machine.issue({
      kind: 'client_api',
      ownerId: body.clientId,
      label: body.label,
      allowedIps: body.allowedIps,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return { key: toIssuedView(issued) };
  }

  /**
   * Одноразовый токен установки узла.
   *
   * Попадает в команду вида `curl … | sudo bash -s -- <токен>`, а та — в историю оболочки
   * и в переписку. Поэтому живёт час и применяется ровно один раз.
   */
  @Roles('admin')
  @Post('enrollment')
  async issueEnrollment(
    @Body(zodBody(issueEnrollmentSchema)) body: z.infer<typeof issueEnrollmentSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ key: IssuedKeyView }> {
    const issued = await this.machine.issue({
      kind: 'enrollment',
      ownerId: null,
      label: body.label,
      allowedIps: body.allowedIps,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return { key: toIssuedView(issued) };
  }

  @Roles('admin')
  @Get()
  async list(@Query('kind') kind?: string): Promise<{ keys: KeyView[] }> {
    const rows = await this.machine.listByKind(parseKind(kind));
    return { keys: rows.map(toKeyView) };
  }

  /**
   * Отзыв. Пометкой, а не удалением строки: иначе в журнале дыра ровно там,
   * где чаще всего и нужно разбираться.
   */
  @Roles('admin')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @CurrentUser() actor: Principal): Promise<void> {
    await this.machine.revoke(parseId(id, 'machineCredential'), actor.userId, actor.role);
  }
}

function toIssuedView(issued: {
  credentialId: string;
  keyId: string;
  secret: string;
  expiresAt: Date | null;
}): IssuedKeyView {
  return {
    credential_id: issued.credentialId,
    key_id: issued.keyId,
    secret: issued.secret,
    expires_at: issued.expiresAt?.toISOString() ?? null,
  };
}

function toKeyView(row: {
  id: string;
  keyId: string;
  kind: string;
  ownerId: string | null;
  label: string;
  allowedIps: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): KeyView {
  // Поля перечислены поимённо, а не расширением строки: при добавлении колонки
  // с секретом расширяющая запись отдала бы её наружу молча.
  return {
    credential_id: row.id,
    key_id: row.keyId,
    kind: row.kind,
    owner_id: row.ownerId,
    label: row.label,
    allowed_ips: row.allowedIps,
    expires_at: row.expiresAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    age_days: Math.floor((Date.now() - row.createdAt.getTime()) / MS_PER_DAY),
  };
}

/** Вид ключа из строки запроса. Неизвестное значение — не «показать всё», а отказ. */
function parseKind(raw: string | undefined): MachineKeyKind {
  switch (raw) {
    case undefined:
    case 'node':
      return 'node';
    case 'client_api':
      return 'client_api';
    case 'enrollment':
      return 'enrollment';
    default:
      throw validationFailed('Неизвестный вид ключа', { details: { kind: raw } });
  }
}
