/**
 * Записи разговоров: выгрузка узлом и выдача человеку (ARCHITECTURE.md).
 *
 * Два правила определяют здесь всё, и оба про персональные данные абонента:
 *
 * 1. **Узел не получает ключей хранилища.** Он получает подписанную ссылку ровно
 *    на один объект и на короткий срок. Ключи дали бы доступ ко всем записям всех
 *    клиентов, и скомпрометированный узел читал бы чужие разговоры.
 * 2. **Каждое обращение к записи попадает в журнал аудита.** Подписанная ссылка
 *    даёт доступ к разговору без всякой дальнейшей проверки прав, поэтому важно,
 *    кто и когда её получил, — а не только кто её открыл.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  isStaffRole,
  notFound,
  permissionDenied,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository, type PartnerRow } from '../billing/billing.repository.js';
import { CallRepository } from '../telephony/call.repository.js';
import { TelephonyRepository } from '../telephony/telephony.repository.js';
import { OBJECT_STORAGE, recordingObjectKey, type ObjectStorage } from './object-storage.js';
import {
  RecordingsRepository,
  type RecordingGrantRow,
  type RecordingRow,
} from './recordings.repository.js';

/** Сколько живёт ссылка на выгрузку. Короче ссылки на прослушивание: узел выгружает сразу. */
const UPLOAD_LINK_TTL_SECONDS = 600;

/** Сколько записей удаляется за один проход уборки. */
export const RETENTION_SWEEP_LIMIT = 200;

export interface UploadTarget {
  readonly recordingId: Id<'recording'>;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly expiresAt: Date;
}

/** Кто просит запись. Роль — первый рубеж, владение проверяется отдельно (ADR-0018). */
export interface Requester {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

@Injectable()
export class RecordingsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: RecordingsRepository,
    private readonly calls: CallRepository,
    private readonly telephony: TelephonyRepository,
    private readonly billing: BillingRepository,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('recordings');
  }

  /**
   * Выдаёт узлу ссылку на выгрузку записи вызова.
   *
   * Ключ объекта задаёт control plane: узел его не выбирает и не может прислать чужой.
   * Повторный запрос по тому же вызову возвращает **ту же** запись с новой ссылкой —
   * первая попытка выгрузки могла не дойти, и это штатный режим, а не вторая запись.
   */
  async prepareUpload(callId: Id<'call'>, nodeId: Id<'node'>): Promise<UploadTarget> {
    const call = await this.calls.findById(callId);
    if (call === undefined) throw notFound('Вызов не найден');
    if (call.nodeId !== nodeId) {
      // Узел выгружает записи только своих вызовов: иначе один узел получал бы
      // ссылку на запись, сделанную другим.
      throw permissionDenied('Вызов обслуживал другой узел');
    }

    const existing = await this.repository.findByCall(callId);
    if (existing !== undefined) {
      if (existing.uploadedAt !== null) {
        throw conflict('Запись уже выгружена');
      }
      return this.signUpload(existing);
    }

    const objectKey = recordingObjectKey(callId, call.startedAt);
    const created = await this.repository.insert({
      callId,
      objectKey,
      expiresAt: new Date(
        call.startedAt.getTime() + this.config.RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ),
    });
    return this.signUpload(created);
  }

  /** Узел отчитался, что файл доехал. До этого запись считается незавершённой. */
  async confirmUpload(
    callId: Id<'call'>,
    nodeId: Id<'node'>,
    facts: { durationSeconds: number; sizeBytes: bigint },
  ): Promise<RecordingRow> {
    const call = await this.calls.findById(callId);
    if (call === undefined) throw notFound('Вызов не найден');
    if (call.nodeId !== nodeId) throw permissionDenied('Вызов обслуживал другой узел');

    const recording = await this.repository.findByCall(callId);
    if (recording === undefined) throw notFound('Ссылка на выгрузку не выдавалась');

    const confirmed = await this.repository.confirmUpload(recording.id, facts, new Date());
    if (confirmed === undefined) throw notFound('Запись не найдена');

    this.logger.info('Запись выгружена', {
      recording_id: confirmed.id,
      call_id: callId,
      size_bytes: facts.sizeBytes.toString(),
    });
    return confirmed;
  }

  /**
   * Подписанная ссылка на прослушивание — **с записью в журнал аудита**.
   *
   * Аудит здесь не формальность: ссылка даёт доступ к разговору без всякой дальнейшей
   * проверки прав, и единственный след того, кто его получил, — эта запись.
   */
  async issueListenLink(
    recordingId: Id<'recording'>,
    requester: Requester,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ url: string; expiresAt: Date }> {
    const recording = await this.repository.findById(recordingId);
    if (recording === undefined) throw notFound('Запись не найдена');
    if (recording.deletedAt !== null) throw notFound('Запись удалена по истечении срока хранения');
    if (recording.uploadedAt === null) throw conflict('Запись ещё не выгружена');

    await this.assertMayListen(recording, requester);

    const ttl = this.config.RECORDING_LINK_TTL_SECONDS;
    const url = await this.storage.presignDownload(recording.objectKey, ttl);

    await this.audit.record({
      action: 'recording.link_issued',
      entityType: 'recording',
      entityId: recording.id,
      actorUserId: requester.userId,
      actorRole: requester.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
      // Ссылка в журнал не пишется: она сама даёт доступ к разговору, а журнал
      // читают больше людей, чем имеют право слушать.
      after: { call_id: recording.callId, link_ttl_seconds: ttl },
    });

    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  /**
   * Право слушать запись.
   *
   * Администратор и поддержка — по роли. Участник — только свои вызовы:
   * владение проверяется здесь, а не защитником (ADR-0018).
   *
   * У партнёра два независимых основания ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)):
   * объявленное намерение слушать записи — и тогда он слышит все свои вызовы, — либо
   * разовый доступ к одной записи, открытый администратором. Второе работает и когда
   * первое выключено: это путь для разбора спора «моя SIM исправна».
   */
  private async assertMayListen(recording: RecordingRow, requester: Requester): Promise<void> {
    if (isStaffRole(requester.role)) return;

    // Участник может быть и клиентом, и партнёром (ADR-0052): запись его, если вызов
    // его хотя бы по одному кабинету. Отказ один на оба — `not_found`, а не
    // `permission_denied`: иначе по разнице ответов проверяется существование чужих записей.
    if (await this.mayListenAsPartner(recording, requester)) return;
    if (await this.mayListenAsClient(recording, requester)) return;
    throw notFound('Запись не найдена');
  }

  private async mayListenAsPartner(
    recording: RecordingRow,
    requester: Requester,
  ): Promise<boolean> {
    const partner = await this.partnerOfRequest(recording, requester);
    if (partner === undefined) return false;
    if (partner.listensToRecordings) return true;

    const grant = await this.repository.findLiveGrant(recording.id, partner.id, new Date());
    return grant !== undefined;
  }

  private async mayListenAsClient(recording: RecordingRow, requester: Requester): Promise<boolean> {
    const client = await this.billing.findClientOwnedBy(requester.userId);
    if (client === undefined) return false;

    const call = await this.calls.findById(recording.callId);
    if (call === undefined) return false;
    const channel = await this.telephony.findChannel(call.channelId);
    return channel !== undefined && channel.clientId === client.id;
  }

  /**
   * Партнёр, чья SIM обслужила вызов этой записи, если он же и спрашивает.
   *
   * `undefined` — спрашивающий к вызову отношения не имеет. Связь идёт через SIM:
   * запись принадлежит вызову, вызов — SIM, SIM — партнёру. Другого способа сказать,
   * что разговор «его», нет.
   */
  private async partnerOfRequest(
    recording: RecordingRow,
    requester: Requester,
  ): Promise<PartnerRow | undefined> {
    const own = await this.billing.findPartnerOwnedBy(requester.userId);
    if (own === undefined) return undefined;

    const terminating = await this.partnerOfRecording(recording);
    if (terminating === undefined || terminating.id !== own.id) return undefined;
    return terminating;
  }

  /** Партнёр, чья SIM обслужила вызов. `undefined` — вызов не дошёл до SIM. */
  private async partnerOfRecording(recording: RecordingRow): Promise<PartnerRow | undefined> {
    const call = await this.calls.findById(recording.callId);
    if (call?.simCardId == null) return undefined;

    const sim = await this.telephony.findSim(call.simCardId);
    if (sim === undefined) return undefined;

    return this.billing.findPartner(sim.partnerId);
  }

  /**
   * Разовый доступ партнёра к одной записи — действие администратора
   * ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
   *
   * Партнёр не называется в запросе, а выводится из вызова: назвать его руками значит
   * однажды назвать не того и выдать чужой разговор. Причина обязательна — доступ
   * к персональным данным без причины не выдаётся.
   */
  async grantAccess(
    recordingId: Id<'recording'>,
    input: { reason: string; hours: number },
    actor: Requester,
  ): Promise<RecordingGrantRow> {
    const recording = await this.repository.findById(recordingId);
    if (recording === undefined) throw notFound('Запись не найдена');
    if (recording.deletedAt !== null) throw notFound('Запись удалена по истечении срока хранения');

    const partner = await this.partnerOfRecording(recording);
    if (partner === undefined) {
      throw conflict('У вызова нет партнёра: открывать доступ некому');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.hours * 60 * 60 * 1000);
    const grant = await this.repository.insertGrant({
      recordingId,
      partnerId: partner.id,
      grantedByUserId: actor.userId,
      reason: input.reason.trim(),
      expiresAt,
    });

    await this.audit.record({
      action: 'recording.access_granted',
      entityType: 'recording',
      entityId: recordingId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: {
        partner_id: partner.id,
        reason: grant.reason,
        expires_at: expiresAt.toISOString(),
      },
    });

    this.logger.info('Партнёру открыт доступ к записи', {
      recording_id: recordingId,
      partner_id: partner.id,
      expires_at: expiresAt.toISOString(),
    });
    return grant;
  }

  /** Отзывает все действующие доступы к записи. */
  async revokeAccess(recordingId: Id<'recording'>, actor: Requester): Promise<number> {
    const recording = await this.repository.findById(recordingId);
    if (recording === undefined) throw notFound('Запись не найдена');

    const now = new Date();
    const revoked = await this.repository.revokeGrants(recordingId, now);

    await this.audit.record({
      action: 'recording.access_revoked',
      entityType: 'recording',
      entityId: recordingId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { revoked },
    });
    return revoked;
  }

  /** Все выданные доступы к записи — для разбора «кому её открывали». */
  async listGrants(recordingId: Id<'recording'>): Promise<RecordingGrantRow[]> {
    return this.repository.listGrants(recordingId);
  }

  private async signUpload(recording: RecordingRow): Promise<UploadTarget> {
    const url = await this.storage.presignUpload(recording.objectKey, UPLOAD_LINK_TTL_SECONDS);
    return {
      recordingId: recording.id,
      objectKey: recording.objectKey,
      uploadUrl: url,
      expiresAt: new Date(Date.now() + UPLOAD_LINK_TTL_SECONDS * 1000),
    };
  }

  /**
   * Удаляет записи, у которых истёк срок хранения.
   *
   * Сначала объект в хранилище, потом отметка в базе. Обратный порядок оставлял бы при
   * сбое запись, помеченную удалённой, а файл — на месте: разговор продолжал бы храниться,
   * и никто бы об этом не знал.
   */
  async removeExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.repository.findExpired(now, RETENTION_SWEEP_LIMIT);
    let removed = 0;

    for (const recording of expired) {
      try {
        await this.storage.remove(recording.objectKey);
      } catch (cause) {
        // Хранилище недоступно — отметку не ставим: запись должна попасть
        // в следующий проход, а не считаться удалённой.
        this.logger.error('Не удалось удалить объект записи', cause, {
          recording_id: recording.id,
          object_key: recording.objectKey,
        });
        continue;
      }
      await this.repository.markDeleted(recording.id, now);
      removed += 1;
    }

    if (removed > 0) {
      this.logger.info('Удалены записи с истёкшим сроком хранения', { count: removed });
    }
    return removed;
  }

  async findByCall(callId: Id<'call'>): Promise<RecordingRow | undefined> {
    return this.repository.findByCall(callId);
  }
}
