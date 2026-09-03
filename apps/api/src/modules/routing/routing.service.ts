/**
 * Выбор шлюза и SIM под конкретный вызов (ARCHITECTURE.md, ADR-0013).
 *
 * Единственное место, где сходятся все проверки этапа 2: оператор, свободная SIM нужного
 * оператора, требование записи, тариф и деньги. Порядок проверок не случаен — сначала
 * дешёвые и определяющие, потом дорогие: определять тариф для номера, которому всё равно
 * нет SIM, значит тратить время в горячем пути.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DomainError, type CallFailureReason, type Id, type Msisdn } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { ReservationService } from '../billing/reservation.service.js';
import { BlockedNumberService } from '../catalog/blocked-numbers.service.js';
import type { LimitRuleRow } from '../limits/limit.repository.js';
import { LimitBreach, LimitService } from '../limits/limit.service.js';
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { CallRepository, type CallRow } from '../telephony/call.repository.js';
import { CdrService } from '../telephony/cdr.service.js';
import {
  TelephonyRepository,
  type ChannelRow,
  type SimCandidate,
} from '../telephony/telephony.repository.js';

/**
 * Сколько ждать внешнего определения оператора.
 *
 * Своя база отвечает за микросекунды; бюджет тратится только на промах. Просроченный
 * запрос не отменяется намеренно: он всё равно допишет ответ в нашу базу, и следующий
 * звонок на этот номер пройдёт (docs/api/node.md, «Бюджет времени»).
 */
const OPERATOR_LOOKUP_BUDGET_MS = 800;

export interface RouteRequest {
  readonly externalId: string;
  readonly channelId: Id<'channel'>;
  readonly nodeId: Id<'node'>;
  readonly destination: Msisdn;
}

/** Решение по вызову: либо список кандидатов, либо причина отказа. */
export type RouteDecision =
  | {
      readonly outcome: 'routed';
      readonly call: CallRow;
      readonly candidates: readonly SimCandidate[];
      readonly recordingRequired: boolean;
      readonly callerId: string | null;
    }
  | { readonly outcome: 'rejected'; readonly reason: CallFailureReason; readonly call?: CallRow };

@Injectable()
export class RoutingService {
  private readonly logger: Logger;

  constructor(
    private readonly telephony: TelephonyRepository,
    private readonly callsRepository: CallRepository,
    private readonly resolver: OperatorResolverService,
    private readonly blocked: BlockedNumberService,
    private readonly limits: LimitService,
    private readonly tariffs: TariffService,
    private readonly reservations: ReservationService,
    private readonly cdr: CdrService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('routing');
  }

  /**
   * Принимает решение по вызову и, если он разрешён, придерживает под него ресурсы:
   * место на SIM и деньги клиента.
   *
   * Повторный запрос с тем же идентификатором вызова возвращает прежнее решение:
   * узел может переспросить, и второй резерв под тот же вызов означал бы, что деньги
   * придержаны дважды за одно и то же.
   */
  async route(request: RouteRequest): Promise<RouteDecision> {
    const existing = await this.callsRepository.findByExternalId(request.externalId);
    if (existing !== undefined) {
      return this.replay(existing);
    }

    const routable = await this.telephony.findRoutableChannel(request.channelId);
    if (routable === undefined) {
      // Канала нет, он отключён или клиенту закрыт доступ. Записать это как `Call`
      // не к чему: у таблицы вызовов канал обязателен, а строка без канала не отвечает
      // ни на один вопрос, ради которого вызовы и пишутся. Остаётся строка в логе.
      this.logger.warn('Запрос маршрута по неизвестному или отключённому каналу', {
        channel_id: request.channelId,
        node_id: request.nodeId,
        external_id: request.externalId,
      });
      return { outcome: 'rejected', reason: 'channel_unknown' };
    }
    const channel = routable.channel;

    // 1. Чёрный список. До определения оператора: тратить бюджет определения (до 800 мс
    //    и запрос во внешний сервис) на номер, звонить на который запрещено, незачем —
    //    и сообщать этот номер внешнему источнику тоже незачем (ADR-0024).
    const block = await this.blocked.findBlock(request.destination);
    if (block !== undefined) {
      // Номер в журнал не пишется — он персональные данные абонента; пишется правило,
      // по которому отказано, и по нему разбор находится сразу.
      this.logger.info('Вызов на запрещённый номер', {
        channel_id: channel.id,
        blocked_number_id: block.id,
        prefix: block.prefix,
      });
      return this.reject(request, channel.id, null, null, 'destination_blocked');
    }

    // 2. Оператор. Гадать запрещено: неверный оператор — платный звонок с денег
    //    партнёра, а промежуточного варианта нет (ADR-0013).
    const resolution = await this.resolveWithinBudget(request.destination);
    if (!resolution.confirmed || resolution.serving === undefined) {
      return this.reject(request, channel.id, null, null, 'operator_unconfirmed');
    }
    const operatorId = resolution.serving.id;
    const region = resolution.region ?? null;

    // 3. Разрешён ли этот оператор каналом (ADR-0025). Проверяется **определённый**
    //    оператор, а не префикс: из-за переносимости номеров префикс называет не того,
    //    и «разрешён» было бы вычислено для оператора, который номер уже не обслуживает.
    if (!(await this.telephony.isOperatorAllowed(channel.id, operatorId))) {
      return this.reject(request, channel.id, operatorId, region, 'operator_not_allowed');
    }

    // 4. Лимиты клиента и канала: исчерпаны — отказ сразу, без отбора SIM и расчёта
    //    тарифа (ADR-0026).
    const at = new Date();
    const subjectLimits = await this.limits.usage(
      { clientId: routable.clientId, channelId: channel.id },
      at,
    );
    const breached = subjectLimits.find((usage) => usage.exceeded);
    if (breached !== undefined) {
      this.logger.info('Вызов отклонён лимитом', {
        channel_id: channel.id,
        limit_rule_id: breached.rule.id,
        metric: breached.rule.metric,
        window: breached.rule.window,
      });
      return this.reject(request, channel.id, operatorId, region, 'limit_exceeded');
    }

    // 5. Кандидаты. Требование записи отсекает шлюзы, где она невозможна (ADR-0012),
    //    регион — партнёров, которые в него не звонят (ADR-0022).
    const candidates = await this.telephony.findSimCandidates(operatorId, {
      channelId: channel.id,
      excludeRecordingIncapable: channel.recordingRequired,
      region,
    });
    if (candidates.length === 0) {
      const reason = await this.explainEmptyCandidates(operatorId, channel, region);
      return this.reject(request, channel.id, operatorId, region, reason);
    }

    // 6. Лимиты партнёров и SIM отсеивают кандидатов, а не отклоняют вызов: лимит
    //    партнёра — защита его SIM, и он не должен мешать позвонить через другого.
    const candidateLimits = await this.limits.usage(
      {
        partnerIds: [...new Set(candidates.map((candidate) => candidate.gateway.partnerId))],
        simCardIds: [...new Set(candidates.map((candidate) => candidate.sim.id))],
      },
      at,
    );
    const exhausted = new Set(
      candidateLimits
        .filter((usage) => usage.exceeded)
        .map((usage) => usage.rule.partnerId ?? usage.rule.simCardId),
    );
    const available = candidates.filter(
      (candidate) =>
        !exhausted.has(candidate.gateway.partnerId) && !exhausted.has(candidate.sim.id),
    );
    if (available.length === 0) {
      // Отдельная причина: «все исчерпали лимит» и «SIM нет вовсе» — разные разговоры
      // с партнёром.
      return this.reject(request, channel.id, operatorId, region, 'limit_exceeded');
    }

    const applicableLimits = [
      ...subjectLimits.map((usage) => usage.rule),
      ...candidateLimits.map((usage) => usage.rule),
    ];

    // 7. Место на SIM и создание вызова — одной транзакцией с блокировкой SIM
    //    и инкрементом счётчиков лимитов.
    let claimed: { call: CallRow; candidate: SimCandidate } | undefined;
    try {
      claimed = await this.claimSim(request, channel, operatorId, region, available, {
        rules: applicableLimits,
        at,
      });
      if (claimed === undefined) {
        // Прежде чем отказать, убираем вызовы, по которым узел не прислал CDR: они
        // занимают место на SIM вечно, и без уборки такая SIM больше не примет звонков.
        // Уборка здесь, а не в горячем пути: отказ — редкий случай, и лишний запрос
        // на нём не мешает, а на каждом успешном вызове мешал бы.
        const closed = await this.cdr.closeCallsWithoutCdr();
        if (closed > 0) {
          claimed = await this.claimSim(request, channel, operatorId, region, available, {
            rules: applicableLimits,
            at,
          });
        }
      }
    } catch (cause) {
      if (cause instanceof LimitBreach) {
        // Счётчик перешагнул предел уже внутри транзакции: две одновременные заявки
        // обе прошли проверку до неё. Транзакция откачена — ни вызова, ни счёта.
        this.logger.info('Вызов отклонён лимитом на записи', {
          channel_id: channel.id,
          limit_rule_id: cause.rule.id,
        });
        return this.reject(request, channel.id, operatorId, region, 'limit_exceeded');
      }
      throw cause;
    }
    if (claimed === undefined) {
      return this.reject(request, channel.id, operatorId, region, 'no_sim_available');
    }

    // 6. Деньги. Считается стоимость разговора предельной длительности: резерв обязан
    //    покрывать любой исход, иначе он не защищает ни от чего.
    try {
      const priced = await this.tariffs.priceReservation(
        claimed.candidate.gateway.partnerId,
        routable.clientId,
        { operatorId, region },
        this.config.MAX_CALL_DURATION_SECONDS,
        new Date(),
      );
      await this.reservations.hold({
        callId: claimed.call.id,
        clientId: routable.clientId,
        amount: priced.charge.clientAmount,
      });
    } catch (cause) {
      // Место на SIM освобождается тем, что вызов помечается несостоявшимся.
      const reason = failureReasonFor(cause);
      await this.callsRepository.setStatus(claimed.call.id, 'failed', {
        failureReason: reason,
        endedAt: new Date(),
      });
      return { outcome: 'rejected', reason, call: claimed.call };
    }

    return {
      outcome: 'routed',
      call: claimed.call,
      // Выбранная SIM первой: узел пробует кандидатов по порядку.
      candidates: [
        claimed.candidate,
        ...available.filter((c) => c.sim.id !== claimed.candidate.sim.id),
      ],
      recordingRequired: channel.recordingRequired,
      callerId: channel.callerId,
    };
  }

  /**
   * Почему кандидатов не оказалось.
   *
   * «Нет SIM вовсе», «есть, но все без записи» и «есть, но регион не покрыт» — три
   * разных разговора с партнёром, а для абонента ещё и три разных кода SIP. Различить
   * их можно только повторив отбор без соответствующего условия.
   *
   * Лишние запросы здесь допустимы: это путь отказа, а не горячий путь. На успешном
   * вызове не выполняется ни один из них.
   */
  private async explainEmptyCandidates(
    operatorId: Id<'operator'>,
    channel: ChannelRow,
    region: string | null,
  ): Promise<CallFailureReason> {
    if (channel.recordingRequired) {
      const withoutRecording = await this.telephony.findSimCandidates(operatorId, {
        channelId: channel.id,
        region,
      });
      if (withoutRecording.length > 0) return 'recording_required';
    }

    const anyRegion = await this.telephony.findSimCandidates(operatorId, {
      channelId: channel.id,
      excludeRecordingIncapable: channel.recordingRequired,
    });
    return anyRegion.length > 0 ? 'no_coverage' : 'no_sim_available';
  }

  /**
   * Занимает место на первой SIM, где оно есть, и создаёт вызов.
   *
   * Блокировка SIM и счёт открытых вызовов — в одной транзакции: без блокировки два
   * одновременных запроса насчитают одно и то же число и оба решат, что место есть,
   * а превышение одновременности на SIM — прямой путь к её блокировке оператором.
   */
  private async claimSim(
    request: RouteRequest,
    channel: ChannelRow,
    operatorId: Id<'operator'>,
    region: string | null,
    candidates: readonly SimCandidate[],
    limits: { rules: readonly LimitRuleRow[]; at: Date },
  ): Promise<{ call: CallRow; candidate: SimCandidate } | undefined> {
    const channelId = channel.id;
    return this.callsRepository.db.transaction(async (tx) => {
      for (const candidate of candidates) {
        const locked = await this.callsRepository.lockSim(candidate.sim.id, tx);
        if (!locked) continue;

        const open = await this.callsRepository.countOpenOnSim(candidate.sim.id, tx);
        if (open >= candidate.sim.maxConcurrentCalls) continue;

        const call = await this.callsRepository.insert(
          {
            externalId: request.externalId,
            channelId,
            nodeId: request.nodeId,
            destination: request.destination,
            operatorId,
            region,
            simCardId: candidate.sim.id,
            gatewayId: candidate.gateway.id,
            status: 'routing',
            failureReason: null,
          },
          tx,
        );

        // Той же транзакцией: отметка о выданном маршруте задаёт очередь среди равных
        // приоритетов, и потерять её при сбое значит раздать очередь одному и тому же
        // партнёру (ADR-0021).
        await this.telephony.markPartnerRouted(
          channelId,
          candidate.gateway.partnerId,
          call.startedAt,
          tx,
        );

        // Той же транзакцией: счётчик и вызов не должны расходиться ни в одну сторону,
        // а повторная проверка после инкремента — единственное, что держит лимит
        // при одновременных заявках (ADR-0026).
        await this.limits.consume(limitsFor(candidate, limits.rules), 'calls', 0, limits.at, tx, {
          verify: true,
        });

        return { call, candidate };
      }
      return undefined;
    });
  }

  /**
   * Определяет оператора в пределах бюджета.
   *
   * Просроченный запрос не отменяется: он допишет ответ в нашу базу, и следующий звонок
   * на этот номер пройдёт. Отказ сейчас — цена за то, чтобы не держать вызов дольше,
   * чем узел готов ждать.
   */
  private async resolveWithinBudget(destination: Msisdn): Promise<{
    confirmed: boolean;
    serving: { id: Id<'operator'> } | undefined;
    region: string | null;
  }> {
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(() => {
        resolve(undefined);
      }, OPERATOR_LOOKUP_BUDGET_MS).unref();
    });

    try {
      const resolution = await Promise.race([this.resolver.resolve(destination), timeout]);
      if (resolution === undefined) {
        this.logger.warn('Определение оператора не уложилось в бюджет', {
          budget_ms: OPERATOR_LOOKUP_BUDGET_MS,
        });
        return { confirmed: false, serving: undefined, region: null };
      }
      return {
        confirmed: resolution.confirmed,
        serving: resolution.serving,
        region: resolution.region ?? null,
      };
    } catch (cause) {
      this.logger.error('Определение оператора не удалось', cause);
      return { confirmed: false, serving: undefined, region: null };
    }
  }

  /** Отказ по известному каналу пишется вызовом: иначе разбирать нечего. */
  private async reject(
    request: RouteRequest,
    channelId: Id<'channel'>,
    operatorId: Id<'operator'> | null,
    region: string | null,
    reason: CallFailureReason,
  ): Promise<RouteDecision> {
    const call = await this.callsRepository.insert({
      externalId: request.externalId,
      channelId,
      nodeId: request.nodeId,
      destination: request.destination,
      operatorId,
      region,
      simCardId: null,
      gatewayId: null,
      status: 'failed',
      failureReason: reason,
    });
    return { outcome: 'rejected', reason, call };
  }

  /** Повтор запроса по тому же вызову возвращает прежнее решение, а не второй резерв. */
  private async replay(call: CallRow): Promise<RouteDecision> {
    if (call.status === 'failed') {
      return { outcome: 'rejected', reason: call.failureReason ?? 'internal_error', call };
    }
    if (call.simCardId === null || call.gatewayId === null) {
      return { outcome: 'rejected', reason: 'internal_error', call };
    }

    // Берётся именно выбранная SIM, а не отбор кандидатов заново: отбор проверяет
    // состояния, а они с момента выдачи маршрута могли измениться — и повтор вернул бы
    // маршрут без единого кандидата, то есть диалплан, по которому некуда звонить.
    const chosen = await this.telephony.findCandidateBySim(call.simCardId);
    if (chosen === undefined) {
      // SIM вынули из порта, пока вызов шёл. Воспроизвести маршрут нечем.
      this.logger.warn('Повтор запроса по вызову, чью SIM уже не найти', {
        call_id: call.id,
        sim_card_id: call.simCardId,
      });
      return { outcome: 'rejected', reason: 'internal_error', call };
    }

    const channel = await this.telephony.findChannel(call.channelId);

    return {
      outcome: 'routed',
      call,
      candidates: [chosen],
      recordingRequired: channel?.recordingRequired ?? false,
      callerId: channel?.callerId ?? null,
    };
  }
}

/** Доменная ошибка тарифа или резерва превращается в причину отказа, понятную поддержке. */
function failureReasonFor(cause: unknown): CallFailureReason {
  if (cause instanceof DomainError) {
    if (cause.code === 'not_found') return 'no_tariff';
    if (cause.code === 'conflict') return 'insufficient_funds';
  }
  return 'internal_error';
}

/**
 * Лимиты, относящиеся к этому кандидату.
 *
 * Клиент и канал — всегда, партнёр и SIM — только свои: считать чужой лимит значит
 * закрыть партнёру трафик за соседа.
 */
function limitsFor(candidate: SimCandidate, rules: readonly LimitRuleRow[]): LimitRuleRow[] {
  return rules.filter(
    (rule) =>
      rule.clientId !== null ||
      rule.channelId !== null ||
      rule.partnerId === candidate.gateway.partnerId ||
      rule.simCardId === candidate.sim.id,
  );
}
