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
  type ShortAnswerRow,
} from './quality.repository.js';
import { TelephonyRepository } from './telephony.repository.js';

/**
 * «Почти не соединяет» ([ADR-0062](../../../../../docs/adr/0062-trevogi-administratoram.md), п. 2): за последний час
 * не меньше 10 вызовов, состоялось меньше 30 %. Числа те же, что «мало вызовов» и красная доля на экране «Качество».
 */
export const POOR_CONNECTION_RULE = {
  windowMinutes: 60,
  enoughCalls: 10,
  maxAsrBasisPoints: 3000,
} as const;

/** Объект в работе почти не соединяет. Отключённый не в счёт: он уже снят. */
export function connectsPoorly(row: QualityView): boolean {
  return (
    row.subjectStatus === 'active' &&
    row.attempts >= POOR_CONNECTION_RULE.enoughCalls &&
    row.asrBasisPoints < POOR_CONNECTION_RULE.maxAsrBasisPoints
  );
}

/**
 * Почти не соединяет **по вине оборудования** ([ADR-0103](../../../../../docs/adr/0103-shlyuz-na-svyazi-po-oprosu-i-trevoga-partnyoru.md),
 * п. 5): не меньше половины несостоявшихся — отказы сети. «Не ответил» и «занято» — про базу клиента: партнёру об этом
 * писать нечего, он их не исправит.
 */
export function failsOnNetwork(row: QualityView): boolean {
  return connectsPoorly(row) && row.networkFailures * 2 >= row.attempts - row.answered;
}

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

/** Признак ложного ответа: сколько отвеченных достаточно, что считать коротким и какая доля коротких подозрительна. */
const SHORT_ANSWER_RULE = { minAnswered: 30, maxSeconds: 3, minShareBasisPoints: 8000 } as const;

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

  /** Что почти не соединяет за окно правила — у всей площадки или у одного партнёра. */
  async poorlyConnecting(
    now: Date,
    partnerId?: Id<'partner'>,
  ): Promise<{ sims: QualityView[]; gateways: QualityView[] }> {
    const since = new Date(now.getTime() - POOR_CONNECTION_RULE.windowMinutes * 60_000);
    const [sims, gateways] = await Promise.all([
      this.sims(since, partnerId),
      this.gateways(since, partnerId),
    ]);
    return { sims: sims.filter(connectsPoorly), gateways: gateways.filter(connectsPoorly) };
  }

  /**
   * Транки, похожие на ложный ответ (ADR-0100, п. 6): за окно отвечено не меньше 30 вызовов, и 80 % из них короче 3 секунд.
   * Только для письма администратору — автомат по ним ничего не отключает: у такси короткий отвеченный звонок бывает честным.
   */
  async shortAnswerTrunks(since: Date): Promise<ShortAnswerRow[]> {
    return this.repository.shortAnswerTrunks(since, SHORT_ANSWER_RULE);
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

    // Шлюзы раньше SIM намеренно: SIM неисправного шлюза отказывает не потому, что
    // с ней что-то не так. Отключив шлюз первым, мы выводим его SIM из отбора того же
    // прохода — иначе администратору пришлось бы включать обратно два объекта вместо одного.
    //
    // Запись — условием на прежнее состояние: решение человека, принятое между отбором
    // и записью, автомат не перезаписывает (ADR-0047). Не совпало — объект пропускается.
    const gatewayThreshold = thresholds.find((row) => row.scope === 'gateway');
    if (gatewayThreshold !== undefined) {
      const since = new Date(now.getTime() - gatewayThreshold.windowMinutes * 60_000);
      for (const found of await this.repository.gatewaysOverThreshold(
        since,
        gatewayThreshold.failures,
      )) {
        const updated = await this.telephony.transitionGateway(
          found.subjectId as Id<'gateway'>,
          { status: 'active', suspendedBy: null },
          { status: 'suspended', suspendedBy: 'failure_threshold' },
        );
        if (updated === undefined) continue;
        // Транк снят за отказы — оператор, похоже, начал резать его номера: прогрев заново (ADR-0105). У GOIP строки
        // транка нет, и запись ничего не меняет.
        await this.telephony.startWarmup({ trunk: found.subjectId as Id<'gateway'> }, now);
        suspensions.push({
          scope: 'gateway',
          subjectId: found.subjectId,
          failures: found.failures,
        });
      }
    }

    const simThreshold = thresholds.find((row) => row.scope === 'sim');
    if (simThreshold !== undefined) {
      const since = new Date(now.getTime() - simThreshold.windowMinutes * 60_000);
      for (const found of await this.repository.simsOverThreshold(since, simThreshold.failures)) {
        const updated = await this.telephony.transitionSimStatus(
          found.subjectId as Id<'simCard'>,
          'active',
          'throttled',
        );
        if (updated === undefined) continue;
        await this.telephony.startWarmup({ sim: found.subjectId as Id<'simCard'> }, now);
        suspensions.push({ scope: 'sim', subjectId: found.subjectId, failures: found.failures });
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
