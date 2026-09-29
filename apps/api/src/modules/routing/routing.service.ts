/**
 * Выбор шлюза и SIM под конкретный вызов (ARCHITECTURE.md, ADR-0013).
 *
 * Единственное место, где сходятся все проверки этапа 2: оператор, свободная SIM нужного
 * оператора, требование записи, тариф и деньги. Порядок проверок не случаен — сначала
 * дешёвые и определяющие, потом дорогие: определять тариф для номера, которому всё равно
 * нет SIM, значит тратить время в горячем пути.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  TERMINATION_KINDS,
  dialledDigits,
  type CallDestination,
  normalizeMsisdn,
  terminationKindOf,
  type CallFailureReason,
  type Id,
  type MoneyAmount,
  type Msisdn,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { ReservationService } from '../billing/reservation.service.js';
import { BlockedNumberService } from '../catalog/blocked-numbers.service.js';
import type { LimitRuleRow } from '../limits/limit.repository.js';
import { LimitBreach, LimitService } from '../limits/limit.service.js';
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { CallRepository, type CallRow, type Executor } from '../telephony/call.repository.js';
import { CdrService } from '../telephony/cdr.service.js';
import {
  TelephonyRepository,
  type ChannelRow,
  type SimCandidate,
  type TerminationCandidate,
  type TrunkCandidate,
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
  /**
   * Набранное как есть, без приведения к каноническому виду.
   *
   * Приводит его `route`, а не вызывающий: отказ по неразобранному номеру пишется
   * вызовом, а вызову нужен канал — значит разбор обязан идти **после** проверки
   * канала, внутри решения
   * ([ADR-0042](../../../../../docs/adr/0042-diagnoz-po-nerazobrannomu-nomeru.md)).
   */
  readonly dialled: string;
}

/** Решение по вызову: либо список кандидатов, либо причина отказа. */
export type RouteDecision =
  | {
      readonly outcome: 'routed';
      readonly call: CallRow;
      readonly candidates: readonly TerminationCandidate[];
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

    // 1. Канал. Нумерация шагов здесь та же, что в таблице проверок
    //    в docs/api/routing.md: читать их приходится вместе, и расхождение номеров
    //    сбивает с толку.
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

    // 1а. Приведение номера к каноническому виду. Короткий, экстренный, служебный
    //    и вовсе не номер отсекаются здесь: до определения оператора такой вызов
    //    не доходит, и называть отказ «оператор не подтверждён» — ложный след
    //    для поддержки (ADR-0042). Порядок обязателен: после канала, потому что
    //    отказ пишется вызовом, и до чёрного списка, потому что его правила —
    //    префиксы канонических номеров (ADR-0024).
    const destination = normalizeMsisdn(request.dialled);
    if (destination === undefined) {
      const digits = dialledDigits(request.dialled);
      // Само набранное в журнал не пишется — это персональные данные абонента;
      // пишется его длина, по которой видно, короткий это номер или мусор.
      this.logger.info('Вызов на неразобранный номер', {
        channel_id: channel.id,
        digits: digits.length,
      });
      return this.reject(request, digits, channel.id, null, null, 'destination_invalid');
    }

    // 2. Чёрный список. До определения оператора: тратить бюджет определения (до 800 мс
    //    и запрос во внешний сервис) на номер, звонить на который запрещено, незачем —
    //    и сообщать этот номер внешнему источнику тоже незачем (ADR-0024).
    const block = await this.blocked.findBlock(destination);
    if (block !== undefined) {
      // Номер в журнал не пишется — он персональные данные абонента; пишется правило,
      // по которому отказано, и по нему разбор находится сразу.
      this.logger.info('Вызов на запрещённый номер', {
        channel_id: channel.id,
        blocked_number_id: block.id,
        prefix: block.prefix,
      });
      return this.reject(request, destination, channel.id, null, null, 'destination_blocked');
    }

    // 3. Оператор: подтверждённый, иначе владелец диапазона
    //    ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)). По нему ищется цена
    //    в тарифе SIM; куда SIM звонит, решает её тариф, а не совпадение сетей. Номера
    //    нет в плане нумерации вовсе — отказ: такой почти всегда набран с ошибкой.
    const resolution = await this.resolveWithinBudget(destination);
    if (resolution.serving === undefined) {
      return this.reject(request, destination, channel.id, null, null, 'operator_unconfirmed');
    }
    const operatorId = resolution.serving.id;
    const region = resolution.region ?? null;

    // 3а. Разрешён ли этот оператор каналом (ADR-0025). Проверяется **определённый**
    //    оператор, а не префикс: из-за переносимости номеров префикс называет не того,
    //    и «разрешён» было бы вычислено для оператора, который номер уже не обслуживает.
    if (!(await this.telephony.isOperatorAllowed(channel.id, operatorId))) {
      return this.reject(
        request,
        destination,
        channel.id,
        operatorId,
        region,
        'operator_not_allowed',
      );
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
      return this.reject(request, destination, channel.id, operatorId, region, 'limit_exceeded');
    }

    // 5. Кандидаты. Требование записи отсекает шлюзы, где она невозможна (ADR-0012),
    //    регион — партнёров, которые в него не звонят (ADR-0022).
    const [simCandidates, trunkCandidates] = await Promise.all([
      this.telephony.findSimCandidates({
        channelId: channel.id,
        excludeRecordingIncapable: channel.recordingRequired,
        region,
        // Только шлюзы **этого** узла: диалплан набирает их как зарегистрированных
        // пользователей, и регистрация живёт там, куда шлюз пришёл.
        nodeId: request.nodeId,
      }),
      // Транк — такой же кандидат, как SIM, без правила «сначала SIM»: разницу в цене
      // клиент видит и учитывает сам (ADR-0039, ADR-0040). Отбор по узлу обязателен:
      // регистрация у провайдера принадлежит конкретному узлу.
      this.telephony.findTrunkCandidates(request.nodeId, { channelId: channel.id, region }),
    ]);
    const candidates: TerminationCandidate[] = [...simCandidates, ...trunkCandidates];
    // 5а. Цена: кандидат — только тот, у кого в тарифе есть цена на этот номер
    //    ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)). Куда SIM звонит,
    //    решает её тариф, поэтому отсев по цене идёт до лимитов и до разбора причин:
    //    карта, которая на этого оператора не звонит, кандидатом не была никогда.
    //    Заодно выстраивается порядок перебора: цена решает при равном приоритете (ADR-0040).
    const priced = await this.orderByPrice(candidates, operatorId, region, at);
    if (priced.length === 0) {
      const reason = await this.explainEmptyCandidates(
        operatorId,
        channel,
        region,
        request.nodeId,
        at,
      );
      return this.reject(request, destination, channel.id, operatorId, region, reason);
    }

    // 5в. Лимиты партнёров и SIM отсеивают кандидатов, а не отклоняют вызов: лимит
    //    партнёра — защита его SIM, и он не должен мешать позвонить через другого.
    const candidateLimits = await this.limits.usage(
      {
        partnerIds: [...new Set(priced.map((entry) => entry.candidate.gateway.partnerId))],
        simCardIds: [
          ...new Set(
            priced
              .map((entry) => entry.candidate)
              .filter((candidate) => candidate.kind === 'sim')
              .map((candidate) => candidate.sim.id),
          ),
        ],
      },
      at,
    );
    const exhausted = new Set(
      candidateLimits
        .filter((usage) => usage.exceeded)
        .map((usage) => usage.rule.partnerId ?? usage.rule.simCardId),
    );
    // Фильтр сохраняет порядок, выстроенный ценой.
    const ordered = priced.filter(
      ({ candidate }) =>
        !exhausted.has(candidate.gateway.partnerId) &&
        (candidate.kind !== 'sim' || !exhausted.has(candidate.sim.id)),
    );
    if (ordered.length === 0) {
      // Отдельная причина: «все исчерпали лимит» и «SIM нет вовсе» — разные разговоры
      // с партнёром.
      return this.reject(request, destination, channel.id, operatorId, region, 'limit_exceeded');
    }

    const applicableLimits = [
      ...subjectLimits.map((usage) => usage.rule),
      ...candidateLimits.map((usage) => usage.rule),
    ];

    // 7. Место на SIM и создание вызова — одной транзакцией с блокировкой SIM
    //    и инкрементом счётчиков лимитов.
    let claimed:
      { call: CallRow; candidate: TerminationCandidate; rateId: Id<'partnerRate'> } | undefined;
    try {
      claimed = await this.claimSim(request, destination, channel, operatorId, region, ordered, {
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
          claimed = await this.claimSim(
            request,
            destination,
            channel,
            operatorId,
            region,
            ordered,
            {
              rules: applicableLimits,
              at,
            },
          );
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
        return this.reject(request, destination, channel.id, operatorId, region, 'limit_exceeded');
      }
      throw cause;
    }
    if (claimed === undefined) {
      return this.reject(request, destination, channel.id, operatorId, region, 'no_sim_available');
    }

    // 8. Деньги. Считается стоимость разговора предельной длительности: резерв обязан
    //    покрывать любой исход, иначе он не защищает ни от чего.
    try {
      const priced = await this.tariffs.priceReservation(
        claimed.rateId,
        routable.clientId,
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
        ...ordered
          .map((entry) => entry.candidate)
          .filter((other) => !isSameCandidate(other, claimed.candidate)),
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
  /**
   * Выстраивает кандидатов в порядке перебора и отбрасывает тех, у кого нет цены.
   *
   * Порядок: приоритет предложения → цена по направлению → давность последнего вызова
   * → номер SIM ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
   *
   * **Цена решает разницу по операторам сама.** Она берётся для фактического направления
   * фактического вызова, поэтому партнёр, дешёвый на МТС и дорогой на Билайне, встаёт
   * первым на МТС и последним на Билайне — без единой настройки у клиента. Списком
   * приоритетов это невыразимо: список один на все направления.
   *
   * Сортируется **тариф партнёра**, а не цена клиента: наценка зависит от клиента,
   * а не от партнёра, то есть переход между ними монотонный и порядок сохраняет.
   * Считать полную цену каждому кандидату значило бы тянуть правило наценки на каждое
   * решение о маршруте ради числа, которое ничего не переставит.
   *
   * Цены спрашиваются **одним запросом на всех**: по запросу на кандидата — это десяток
   * обращений в горячем пути там, где хватает одного.
   */
  private async orderByPrice(
    candidates: readonly TerminationCandidate[],
    operatorId: Id<'operator'>,
    region: string | null,
    at: Date,
  ): Promise<PricedCandidate[]> {
    // Цена — своя у каждого кандидата: по тарифу SIM, иначе тарифу шлюза, иначе тарифу
    // партнёра по умолчанию (ADR-0056). Способ терминации — часть ключа цены (ADR-0040).
    const rates = await this.tariffs.ratesFor(
      candidates.map((candidate) => ({
        partnerId: candidate.gateway.partnerId,
        tariffId:
          (candidate.kind === 'sim' ? candidate.sim.tariffId : null) ?? candidate.gateway.tariffId,
        terminationKind: terminationKindOf(candidate.gateway.type),
      })),
      operatorId,
      region,
      at,
    );

    const priced = candidates.flatMap((candidate, index) => {
      const rate = rates[index];
      return rate === undefined ? [] : [{ candidate, price: rate.pricePerMinute, rateId: rate.id }];
    });

    // Устойчивая сортировка: при полном равенстве остаётся порядок, заданный запросом,
    // то есть по номеру SIM. Без него один и тот же отбор давал бы разный перебор.
    return priced.sort((left, right) => compareCandidates(left, right));
  }

  private async explainEmptyCandidates(
    operatorId: Id<'operator'>,
    channel: ChannelRow,
    region: string | null,
    nodeId: Id<'node'>,
    at: Date,
  ): Promise<CallFailureReason> {
    // Каждый ослабленный отбор тоже сужается ценой (ADR-0056): карта, которая на этого
    // оператора не звонит, не делает вызов ни «вопросом записи», ни «вопросом региона».
    const pricedSims = async (
      options: Parameters<TelephonyRepository['findSimCandidates']>[0],
    ): Promise<number> => {
      const found = await this.telephony.findSimCandidates(options);
      return (await this.orderByPrice(found, operatorId, region, at)).length;
    };

    if (channel.recordingRequired) {
      if ((await pricedSims({ channelId: channel.id, region, nodeId })) > 0) {
        return 'recording_required';
      }
    }

    const recording = { excludeRecordingIncapable: channel.recordingRequired };
    if ((await pricedSims({ channelId: channel.id, ...recording, nodeId })) > 0) {
      return 'no_coverage';
    }

    // Тот же отбор, но по всей площадке. Нашлось — значит SIM есть, а не хватает
    // регистрации: партнёр не включил оборудование, оно потеряло связь или пришло
    // на соседний узел. Для поддержки это разговор о железе, а не о недостатке SIM,
    // и смешивать их значит отправлять её не туда.
    if ((await pricedSims({ channelId: channel.id, ...recording })) > 0) {
      return 'gateway_unregistered';
    }

    // Карты есть, но ни в одном тарифе нет цены на этот номер — разговор с партнёрами
    // об их тарифах, а не с клиентом о свободных SIM.
    const any = await this.telephony.findSimCandidates({
      channelId: channel.id,
      ...recording,
      nodeId,
    });
    return any.length > 0 ? 'no_tariff' : 'no_sim_available';
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
    /** Уже приведённый номер: в запросе лежит набранное, а в вызов идёт канонический. */
    destination: Msisdn,
    channel: ChannelRow,
    operatorId: Id<'operator'>,
    region: string | null,
    candidates: readonly PricedCandidate[],
    limits: { rules: readonly LimitRuleRow[]; at: Date },
  ): Promise<
    { call: CallRow; candidate: TerminationCandidate; rateId: Id<'partnerRate'> } | undefined
  > {
    const channelId = channel.id;
    return this.callsRepository.db.transaction(async (tx) => {
      for (const { candidate, rateId } of candidates) {
        // Ёмкость у SIM и транка своя, но правило одно: блокировка строки, потом счёт
        // открытых вызовов. У SIM предел ставит оператор, у транка — договор
        // с провайдером, и превышение обоих одинаково кончается сорванными вызовами.
        const claimed =
          candidate.kind === 'sim'
            ? await this.claimSlotOnSim(candidate, tx)
            : await this.claimSlotOnTrunk(candidate, tx);
        if (!claimed) continue;

        const call = await this.callsRepository.insert(
          {
            externalId: request.externalId,
            channelId,
            nodeId: request.nodeId,
            destination,
            operatorId,
            region,
            simCardId: candidate.kind === 'sim' ? candidate.sim.id : null,
            gatewayId: candidate.gateway.id,
            // Цена, по которой вызов пошёл: по ней и тарифицируется (ADR-0056).
            partnerRateId: rateId,
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
          terminationKindOf(candidate.gateway.type),
          call.startedAt,
          tx,
        );

        // Той же транзакцией: счётчик и вызов не должны расходиться ни в одну сторону,
        // а повторная проверка после инкремента — единственное, что держит лимит
        // при одновременных заявках (ADR-0026).
        await this.limits.consume(limitsFor(candidate, limits.rules), 'calls', 0, limits.at, tx, {
          verify: true,
        });

        return { call, candidate, rateId };
      }
      return undefined;
    });
  }

  /** Место на SIM: предел ставит оператор, и превышение блокирует карту. */
  private async claimSlotOnSim(candidate: SimCandidate, tx: Executor): Promise<boolean> {
    if (!(await this.callsRepository.lockSim(candidate.sim.id, tx))) return false;
    const open = await this.callsRepository.countOpenOnSim(candidate.sim.id, tx);
    return open < candidate.sim.maxConcurrentCalls;
  }

  /** Канал транка: предел договорной, и превышение провайдер отвергает. */
  private async claimSlotOnTrunk(candidate: TrunkCandidate, tx: Executor): Promise<boolean> {
    if (!(await this.callsRepository.lockTrunk(candidate.gateway.id, tx))) return false;
    const open = await this.callsRepository.countOpenOnGateway(candidate.gateway.id, tx);
    return open < candidate.trunk.maxConcurrentCalls;
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
    /** Обслуживающий оператор, а без подтверждения — владелец диапазона (ADR-0056). */
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
        return this.rangeOwnerOf(destination);
      }
      return {
        confirmed: resolution.confirmed,
        serving: resolution.serving ?? resolution.rangeOwner,
        region: resolution.region ?? null,
      };
    } catch (cause) {
      this.logger.error('Определение оператора не удалось', cause);
      return this.rangeOwnerOf(destination);
    }
  }

  /** Владелец диапазона по своему плану нумерации — запасной путь без сети. */
  private async rangeOwnerOf(destination: Msisdn): Promise<{
    confirmed: boolean;
    serving: { id: Id<'operator'> } | undefined;
    region: string | null;
  }> {
    const plan = await this.resolver.fromNumberingPlan(destination);
    return { confirmed: false, serving: plan.rangeOwner, region: plan.region ?? null };
  }

  /** Отказ по известному каналу пишется вызовом: иначе разбирать нечего. */
  private async reject(
    request: RouteRequest,
    /**
     * Что записать назначением. Канонический номер везде, кроме отказа
     * `destination_invalid`: там записываются цифры набранного — иначе причине
     * отказа не к чему относиться (ADR-0042).
     */
    destination: CallDestination,
    channelId: Id<'channel'>,
    operatorId: Id<'operator'> | null,
    region: string | null,
    reason: CallFailureReason,
  ): Promise<RouteDecision> {
    const call = await this.callsRepository.insert({
      externalId: request.externalId,
      channelId,
      nodeId: request.nodeId,
      destination,
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
    if (call.gatewayId === null) {
      return { outcome: 'rejected', reason: 'internal_error', call };
    }

    // Берётся именно выбранная ёмкость, а не отбор кандидатов заново: отбор проверяет
    // состояния, а они с момента выдачи маршрута могли измениться — и повтор вернул бы
    // маршрут без единого кандидата, то есть диалплан, по которому некуда звонить.
    const chosen =
      call.simCardId === null
        ? await this.telephony.findTrunkCandidate(call.gatewayId)
        : await this.telephony.findCandidateBySim(call.simCardId);
    if (chosen === undefined) {
      // SIM вынули из порта или транк удалили, пока вызов шёл. Воспроизвести нечем.
      this.logger.warn('Повтор запроса по вызову, чью ёмкость уже не найти', {
        call_id: call.id,
        sim_card_id: call.simCardId,
        gateway_id: call.gatewayId,
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
function limitsFor(
  candidate: TerminationCandidate,
  rules: readonly LimitRuleRow[],
): LimitRuleRow[] {
  return rules.filter(
    (rule) =>
      rule.clientId !== null ||
      rule.channelId !== null ||
      rule.partnerId === candidate.gateway.partnerId ||
      // Лимит на SIM транка не касается: карты у него нет, и правило про чужую карту
      // не должно его задевать.
      (candidate.kind === 'sim' && rule.simCardId === candidate.sim.id),
  );
}

/**
 * Один ли это кандидат.
 *
 * По шлюзу и SIM вместе: у транка SIM нет, а у GOIP один шлюз несёт много карт,
 * и сравнение по одному только шлюзу выбросило бы из перебора все остальные.
 */
function isSameCandidate(left: TerminationCandidate, right: TerminationCandidate): boolean {
  if (left.gateway.id !== right.gateway.id) return false;
  if (left.kind === 'sim' && right.kind === 'sim') return left.sim.id === right.sim.id;
  return left.kind === right.kind;
}

/** Приоритет не задан — идёт после всех названных, а не впереди них. */
const WITHOUT_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * Порядок двух кандидатов: приоритет предложения, затем цена, затем давность.
 *
 * Давность работает **между равноценными**, а не между всеми равноприоритетными
 * ([ADR-0021](../../../../../docs/adr/0021-ravnomernoe-raspredelenie.md), уточнён
 * [ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)):
 * делить трафик поровну между дешёвым и дорогим значит половину вызовов делать дороже
 * без причины.
 */
/** Кандидат с ценой, по которой через него пойдёт вызов (ADR-0056). */
interface PricedCandidate {
  readonly candidate: TerminationCandidate;
  readonly price: MoneyAmount;
  readonly rateId: Id<'partnerRate'>;
}

function compareCandidates(left: PricedCandidate, right: PricedCandidate): number {
  const byPriority =
    (left.candidate.priority ?? WITHOUT_PRIORITY) - (right.candidate.priority ?? WITHOUT_PRIORITY);
  if (byPriority !== 0) return byPriority;

  if (left.price !== right.price) return left.price < right.price ? -1 : 1;

  // Ни разу не звонивший идёт первым: у него отметки нет вовсе.
  const leftAt = left.candidate.lastRoutedAt?.getTime() ?? 0;
  const rightAt = right.candidate.lastRoutedAt?.getTime() ?? 0;
  return leftAt - rightAt;
}
