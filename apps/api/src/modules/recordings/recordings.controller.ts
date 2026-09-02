/**
 * Выдача записи человеку.
 *
 * Записи разговоров — персональные данные абонента, и доступ к ним устроен так:
 * **только по подписанной ссылке с коротким сроком и только с записью в журнал аудита**
 * (правило из CLAUDE.md). Сам файл через control plane не проходит.
 */

import { Controller, Get, Param, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser, Meta } from '../../http/request-context.js';
import type { Principal, RequestMeta } from '../identity/identity.service.js';
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
   * Роль — только первый рубеж. Клиент получает ссылку лишь на свои вызовы; проверку
   * владения делает сервис (ADR-0018). Чужая запись отвечает `404`, а не `403`:
   * иначе по разнице ответов проверяется её существование.
   */
  @Roles('admin', 'support', 'client')
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
