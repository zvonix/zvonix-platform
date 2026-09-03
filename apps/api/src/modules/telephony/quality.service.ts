/**
 * Качество терминации и автоматическое отключение
 * ([ADR-0027](../../../../../docs/adr/0027-porog-otklyucheniya.md)).
 *
 * Две разные задачи, которые легко перепутать: **измерить** (ASR, ACD — чтобы человек
 * видел) и **отключить неисправное** (автоматически). Автомат смотрит только на отказы
 * сети: ASR падает, когда клиент звонит по холодной базе, и отключать за это SIM партнёра
 * значит наказывать его за поведение чужих абонентов.
 */

import { Inject, Injectable } from '@nestjs/common';
import { notFound, type FailureScope, type Id, type UserRole } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import {
  QualityRepository,
  type FailureThresholdRow,
  type QualityRow,
} from './quality.repository.js';
import { TelephonyRepository } from './telephony.repository.js';

/** Качество объекта за окно — то, что видит человек. */
export interface QualityView extends QualityRow {
  /** Доля отвеченных, в десятитысячных: 4210 значит 42,1%. */
  readonly asrBasisPoints: number;
  /** Средняя длительность отвеченного разговора в секундах. */
  readonly acdSeconds: number;
}

/** Что сделал проход порогов: по одной записи на отключённый объект. */
interface Suspension {
  readonly scope: FailureScope;
  readonly subjectId: string;
  readonly failures: number;
}

@Injectable()
export class QualityService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: QualityRepository,
    private readonly telephony: TelephonyRepository,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('quality');
  }

  async sims(since: Date, partnerId?: Id<'partner'>): Promise<QualityView[]> {
    return (await this.repository.simQuality(since, partnerId)).map(withRatios);
  }

  async gateways(since: Date, partnerId?: Id<'partner'>): Promise<QualityView[]> {
    return (await this.repository.gatewayQuality(since, partnerId)).map(withRatios);
  }

  // --- Пороги ---------------------------------------------------------------------

  async listThresholds(): Promise<FailureThresholdRow[]> {
    return this.repository.listThresholds();
  }

  async setThreshold(
    draft: { scope: FailureScope; failures: number; windowMinutes: number },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<FailureThresholdRow> {
    const before = await this.repository.findThreshold(draft.scope);
    const row = await this.repository.upsertThreshold(draft);

    await this.audit.record({
      action: 'failure_threshold.set',
      entityType: 'failure_threshold',
      entityId: row.id,
      actorUserId,
      actorRole,
      ...(before === undefined
        ? {}
        : { before: { failures: before.failures, window_minutes: before.windowMinutes } }),
      after: { scope: row.scope, failures: row.failures, window_minutes: row.windowMinutes },
    });
    return row;
  }

  async removeThreshold(
    scope: FailureScope,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<FailureThresholdRow> {
    const removed = await this.repository.deleteThreshold(scope);
    if (removed === undefined) throw notFound('Порог не задан');

    await this.audit.record({
      action: 'failure_threshold.removed',
      entityType: 'failure_threshold',
      entityId: removed.id,
      actorUserId,
      actorRole,
      before: {
        scope: removed.scope,
        failures: removed.failures,
        window_minutes: removed.windowMinutes,
      },
    });
    return removed;
  }

  /**
   * Снимает с маршрутизации то, что набрало отказов сверх порога.
   *
   * Проход фоновой задачи, а не проверка в горячем пути: агрегат по вызовам на каждое
   * решение о маршруте — это чтение тысяч строк ради ответа, который меняется раз
   * в минуты.
   *
   * Обратно объекты **не возвращаются**: отключённая SIM не получает вызовов, её окно
   * опустеет само собой, и автоматический возврат превратился бы в мигание — с реальными
   * вызовами клиентов в каждой попытке (ADR-0027).
   */
  async suspendOverThreshold(now: Date = new Date()): Promise<number> {
    const thresholds = await this.repository.listThresholds();
    if (thresholds.length === 0) return 0;

    const suspensions: Suspension[] = [];

    for (const threshold of thresholds) {
      const since = new Date(now.getTime() - threshold.windowMinutes * 60_000);

      if (threshold.scope === 'sim') {
        for (const found of await this.repository.simsOverThreshold(since, threshold.failures)) {
          const updated = await this.telephony.setSimStatus(
            found.subjectId as Id<'simCard'>,
            'throttled',
          );
          if (updated === undefined) continue;
          suspensions.push({ scope: 'sim', subjectId: found.subjectId, failures: found.failures });
        }
        continue;
      }

      for (const found of await this.repository.gatewaysOverThreshold(since, threshold.failures)) {
        const updated = await this.telephony.setGatewayStatus(
          found.subjectId as Id<'gateway'>,
          'suspended',
        );
        if (updated === undefined) continue;
        suspensions.push({
          scope: 'gateway',
          subjectId: found.subjectId,
          failures: found.failures,
        });
      }
    }

    for (const suspension of suspensions) {
      // Предупреждение, а не запись уровня «сделано»: партнёр перестал получать вызовы,
      // и это должно быть видно в логе без раскопок.
      this.logger.warn('Объект снят с маршрутизации по отказам сети', {
        scope: suspension.scope,
        subject_id: suspension.subjectId,
        failures: suspension.failures,
      });
      // Инициатора нет: отключил автомат. Числа остаются в журнале, иначе на вопрос
      // партнёра «за что» отвечать нечем.
      await this.audit.record({
        action: `${suspension.scope}.suspended_by_failures`,
        entityType: suspension.scope === 'sim' ? 'sim_card' : 'gateway',
        entityId: suspension.subjectId,
        actorUserId: null,
        actorRole: null,
        after: { failures: suspension.failures },
      });
    }

    return suspensions.length;
  }
}

/**
 * ASR и ACD.
 *
 * Считаются здесь, а не в SQL: деление на ноль в агрегате даёт `null`, который потом
 * приходится разбирать на каждом чтении, а тут отсутствие попыток честно означает ноль.
 */
function withRatios(row: QualityRow): QualityView {
  return {
    ...row,
    asrBasisPoints: row.attempts === 0 ? 0 : Math.round((row.answered * 10_000) / row.attempts),
    acdSeconds: row.answered === 0 ? 0 : Math.round(row.talkSeconds / row.answered),
  };
}
