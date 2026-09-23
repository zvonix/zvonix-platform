/**
 * Выдача записи человеку.
 *
 * Записи разговоров — персональные данные абонента, и доступ к ним устроен так:
 * **только по подписанной ссылке с коротким сроком и только с записью в журнал аудита**
 * (правило из CLAUDE.md). Сам файл через control plane не проходит.
 */

import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { zodBody } from '../../http/zod.pipe.js';
import { CurrentUser, Meta } from '../../http/request-context.js';
import type { Principal, RequestMeta } from '../identity/identity.service.js';
import { grantRecordingAccessSchema } from './schemas.js';
import { RecordingsService } from './recordings.service.js';

@Controller('recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /**
   * Ссылка на прослушивание.
   *
   * `POST`, а не `GET`, намеренно: обращение **меняет состояние** — оно попадает
   * в журнал аудита, и повторять его перезагрузкой страницы или предзагрузкой браузера
   * не должно быть бесплатным. По `GET` журнал засорился бы обращениями, которых
   * никто не совершал.
   *
   * Роль — только первый рубеж. Клиент и партнёр получают ссылку лишь на свои вызовы;
   * проверку владения делает сервис (ADR-0018). Чужая запись отвечает `404`, а не `403`:
   * иначе по разнице ответов проверяется её существование.
   *
   * Партнёр слышит запись, если объявил это в своих настройках либо если администратор
   * открыл ему разовый доступ по спорному вызову
   * ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
   */
  @Roles('admin', 'support')
  @Cabinets('client', 'partner')
  @Post(':id/link')
  async listenLink(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string; expires_at: string }> {
    const link = await this.recordings.issueListenLink(
      parseId(id, 'recording'),
      { userId: actor.userId, role: actor.role },
      { ip: meta.ip, userAgent: meta.userAgent },
    );

    return { url: link.url, expires_at: link.expiresAt.toISOString() };
  }

  /**
   * Открыть партнёру разовый доступ к записи — действие администратора.
   *
   * Партнёр не называется: он выводится из вызова, чью SIM тот обслужил. Причина
   * обязательна, срок ограничен — доступ, который не истекает, перестаёт быть разовым
   * ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
   */
  @Roles('admin')
  @Post(':id/grant')
  async grant(
    @Param('id') id: string,
    @Body(zodBody(grantRecordingAccessSchema)) body: z.infer<typeof grantRecordingAccessSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ grant: { partner_id: string; reason: string; expires_at: string } }> {
    const grant = await this.recordings.grantAccess(parseId(id, 'recording'), body, {
      userId: actor.userId,
      role: actor.role,
    });

    return {
      grant: {
        partner_id: grant.partnerId,
        reason: grant.reason,
        expires_at: grant.expiresAt.toISOString(),
      },
    };
  }

  /** Отозвать все действующие доступы к записи. */
  @Roles('admin')
  @Delete(':id/grant')
  async revoke(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ revoked: number }> {
    const revoked = await this.recordings.revokeAccess(parseId(id, 'recording'), {
      userId: actor.userId,
      role: actor.role,
    });
    return { revoked };
  }

  /**
   * Кому открывали эту запись.
   *
   * Отдаются и погашенные доступы: это след, а не список действующих прав. Вопрос
   * «кто слушал разговор» разбирается по нему и по журналу действий.
   */
  @Roles('admin', 'support')
  @Get(':id/grants')
  async grants(@Param('id') id: string): Promise<{
    grants: {
      partner_id: string;
      reason: string;
      expires_at: string;
      revoked_at: string | null;
      created_at: string;
    }[];
  }> {
    const rows = await this.recordings.listGrants(parseId(id, 'recording'));
    return {
      grants: rows.map((row) => ({
        partner_id: row.partnerId,
        reason: row.reason,
        expires_at: row.expiresAt.toISOString(),
        revoked_at: row.revokedAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Есть ли запись у вызова и в каком она состоянии.
   *
   * Отдельно от ссылки: узнать, что запись есть, — не то же самое, что её послушать,
   * и второе требует следа в журнале, а первое нет.
   */
  @Roles('admin', 'support')
  @Get('by-call/:callId')
  async byCall(@Param('callId') callId: string): Promise<{
    recording: {
      id: string;
      object_key: string;
      duration_seconds: number | null;
      size_bytes: string | null;
      uploaded_at: string | null;
      expires_at: string;
      deleted_at: string | null;
    } | null;
  }> {
    const found = await this.recordings.findByCall(parseId(callId, 'call'));
    if (found === undefined) return { recording: null };

    return {
      recording: {
        id: found.id,
        object_key: found.objectKey,
        duration_seconds: found.durationSeconds,
        size_bytes: found.sizeBytes?.toString() ?? null,
        uploaded_at: found.uploadedAt?.toISOString() ?? null,
        expires_at: found.expiresAt.toISOString(),
        deleted_at: found.deletedAt?.toISOString() ?? null,
      },
    };
  }
}
