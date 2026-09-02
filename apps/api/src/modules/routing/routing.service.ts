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
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { CallRepository, type CallRow } from '../telephony/call.repository.js';
import { CdrService } from '../telephony/cdr.service.js';
import { TelephonyRepository, type SimCandidate } from '../telephony/telephony.repository.js';

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

    // 1. Оператор. Гадать запрещено: неверный оператор — платный звонок с денег
    //    партнёра, а промежуточного варианта нет (ADR-0013).
    const resolution = await this.resolveWithinBudget(request.destination);
    if (!resolution.confirmed || resolution.serving === undefined) {
      return this.reject(request, channel.id, null, null, 'operator_unconfirmed');
    }
    const operatorId = resolution.serving.id;
    const region = resolution.region ?? null;

    // 2. Кандидаты. Требование записи отсекает шлюзы, где она невозможна (ADR-0012).
    const candidates = await this.telephony.findSimCandidates(operatorId, {
      excludeRecordingIncapable: channel.recordingRequired,
    });
    if (candidates.length === 0) {
      // Различаем «нет SIM вовсе» и «есть, но все без записи»: для поддержки это
      // два разных разговора с партнёром.
      const reason: CallFailureReason = channel.recordingRequired
        ? (await this.telephony.findSimCandidates(operatorId)).length > 0
          ? 'recording_required'
          : 'no_sim_available'
        : 'no_sim_available';
      return this.reject(request, channel.id, operatorId, region, reason);
    }

    // 3. Место на SIM и создание вызова — одной транзакцией с блокировкой SIM.
    let claimed = await this.claimSim(request, channel.id, operatorId, region, candidates);
    if (claimed === undefined) {
      // Прежде чем отказать, убираем вызовы, по которым узел не прислал CDR: они
      // занимают место на SIM вечно, и без уборки такая SIM больше не примет звонков.
      // Уборка здесь, а не в горячем пути: отказ — редкий случай, и лишний запрос
      // на нём не мешает, а на каждом успешном вызове мешал бы.
      const closed = await this.cdr.closeCallsWithoutCdr();
      if (closed > 0) {
        claimed = await this.claimSim(request, channel.id, operatorId, region, candidates);
      }
    }
    if (claimed === undefined) {
      return this.reject(request, channel.id, operatorId, region, 'no_sim_available');
    }

    // 4. Деньги. Считается стоимость разговора предельной длительности: резерв обязан
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
        ...candidates.filter((c) => c.sim.id !== claimed.candidate.sim.id),
      ],
      recordingRequired: channel.recordingRequired,
      callerId: channel.callerId,
    };
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
    channelId: Id<'channel'>,
    operatorId: Id<'operator'>,
    region: string | null,
    candidates: readonly SimCandidate[],
  ): Promise<{ call: CallRow; candidate: SimCandidate } | undefined> {
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

    const channel = await this.telephony.findChannel(call.channelId);
    const candidates = await this.telephony.findSimCandidates(
      call.operatorId ?? ('' as Id<'operator'>),
    );
    const chosen = candidates.filter((candidate) => candidate.sim.id === call.simCardId);

    return {
      outcome: 'routed',
      call,
      candidates: chosen,
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
