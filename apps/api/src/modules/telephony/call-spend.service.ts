/**
 * Деньги идущих разговоров ([ADR-0125](../../../../../docs/adr/0125-dengi-na-zvonok-bez-rezerva.md)).
 *
 * Резерва под звонок больше нет. Вместо него одна служба считает стоимость идущих разговоров клиента на сейчас —
 * и для решения на старте, и для проверки каждые 15 секунд. Одна, а не две копии: разойдись старт и проверка
 * в расчёте, задача обрывала бы звонки, которые маршрутизация только что пустила.
 *
 * Стоимость — по запомненной строке цены вызова и правилу наценки клиента, тем же `chargeForCall`, что
 * тарифицирует CDR. Время — от выдачи маршрута: момент ответа приходит только с CDR.
 */

import { Inject, Injectable } from '@nestjs/common';
import { chargeForCall, connectionCharge, Money, type Id, type MoneyAmount } from '@zvonix/shared';
import { EslError } from '../../infra/esl.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { ReservationService } from '../billing/reservation.service.js';
import { TariffService, type AppliedTariff } from '../catalog/tariff.service.js';
import { NodeCommandsService } from '../nodes/node-commands.service.js';
import {
  callsToCut,
  elapsedSeconds,
  NODE_CALL_UUID,
  startAllowed,
  type SpendingCall,
} from './call-spend.js';
import { CallRepository, type OpenCallSpend } from './call.repository.js';

/** Сколько ждать ответа узла на обрыв. Служба команд забирает команду за секунду; дольше — пробует следующий проход. */
const CUT_OFF_TIMEOUT_MS = 10_000;

/** Решение на старте и из чего оно сложилось — для журнала и разбора. */
export interface StartFunds {
  readonly allowed: boolean;
  /** Остаток + разрешённый минус − резервы. */
  readonly available: MoneyAmount;
  /** Стоимость остальных идущих разговоров клиента на сейчас. */
  readonly spent: MoneyAmount;
  /** Плата за соединение этого звонка для клиента. */
  readonly connection: MoneyAmount;
}

@Injectable()
export class CallSpendService {
  private readonly logger: Logger;

  constructor(
    private readonly calls: CallRepository,
    private readonly tariffs: TariffService,
    private readonly reservations: ReservationService,
    private readonly nodeCommands: NodeCommandsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('call-spend');
  }

  /**
   * Можно ли начать звонок `callId` по строке цены `rateId`.
   *
   * Сам вызов к этому моменту уже записан (шаг 7 маршрутизации) и в сумму не входит — за него отвечает плата
   * за соединение. Одновременные начала видят друг друга строками вызовов: каждая проверка видит все вызовы
   * клиента, созданные раньше неё (ADR-0125, «Гонка одновременных начал»).
   */
  async checkStart(
    clientId: Id<'client'>,
    callId: Id<'call'>,
    rateId: Id<'partnerRate'>,
    now: Date = new Date(),
  ): Promise<StartFunds> {
    const [funds, open, applied] = await Promise.all([
      this.reservations.available(clientId),
      this.calls.listOpenSpend(now, clientId),
      this.tariffs.resolveRate(rateId, clientId, now),
    ]);
    const others = await this.priced(
      open.filter((call) => call.id !== callId),
      now,
    );
    const spent = sum(others);
    const connection = connectionCharge(applied.rule, applied.commission);
    return {
      allowed: startAllowed(Money.subtract(funds.available, spent), connection),
      available: funds.available,
      spent,
      connection,
    };
  }

  /**
   * Проверка во время разговора — фоновая задача `calls.watch-spend`, раз в 15 секунд.
   *
   * Берёт всех клиентов с открытыми вызовами; у вышедшего за свой минус обрывает самые новые разговоры, пока
   * не уложится. Идемпотентна и догоняюща (ADR-0020): работа — текущее состояние, а не «с прошлого запуска»;
   * необорванное из-за недоступного узла пробует следующий проход. Возвращает, сколько разговоров оборвано.
   */
  async watch(now: Date = new Date()): Promise<number> {
    const open = await this.calls.listOpenSpend(now);
    const byClient = new Map<Id<'client'>, OpenCallSpend[]>();
    for (const call of open) {
      const list = byClient.get(call.clientId);
      if (list === undefined) byClient.set(call.clientId, [call]);
      else list.push(call);
    }

    let cut = 0;
    for (const [clientId, calls] of byClient) {
      try {
        cut += await this.watchClient(clientId, calls, now);
      } catch (cause) {
        // Один клиент без правила наценки или счёта не должен оставлять без проверки остальных.
        this.logger.error('Проверка денег идущих разговоров не удалась', cause, {
          client_id: clientId,
        });
      }
    }
    return cut;
  }

  private async watchClient(
    clientId: Id<'client'>,
    calls: readonly OpenCallSpend[],
    now: Date,
  ): Promise<number> {
    const funds = await this.reservations.available(clientId);
    const priced = await this.priced(calls, now);
    const toCut = callsToCut(funds.available, priced);
    if (toCut.length === 0) return 0;

    this.logger.warn('Клиент вышел за разрешённый минус: обрываем самые новые разговоры', {
      client_id: clientId,
      available: Money.format(funds.available),
      spent: Money.format(sum(priced)),
      open_calls: calls.length,
      to_cut: toCut.length,
    });
    const byId = new Map(calls.map((call) => [call.id, call]));
    // Разом, а не по очереди: узлу на отдельной машине каждая команда — долгий опрос, и пачка по очереди
    // не уложилась бы в 15 секунд.
    const done = await Promise.all(
      toCut.map(async (entry) => {
        const call = byId.get(entry.id);
        return call === undefined ? false : this.cutOff(call);
      }),
    );
    return done.filter(Boolean).length;
  }

  /** Оборвать разговор на узле и отметить. Отметка — только после `+OK` узла: иначе следующий проход попробует снова. */
  private async cutOff(call: OpenCallSpend): Promise<boolean> {
    if (!NODE_CALL_UUID.test(call.externalId)) {
      // Узлу уходит только UUID канала; всё остальное служба команд отвергнет, и строка не годится в команду.
      this.logger.warn('Идентификатор вызова на узле — не UUID канала: оборвать нечем', {
        call_id: call.id,
      });
      return false;
    }
    let reply: string;
    try {
      reply = await this.nodeCommands.run(
        call.nodeId,
        `uuid_kill ${call.externalId}`,
        CUT_OFF_TIMEOUT_MS,
      );
    } catch (cause) {
      if (!(cause instanceof EslError)) throw cause;
      this.logger.warn('Узел не принял обрыв разговора: попробуем следующим проходом', {
        call_id: call.id,
        node_id: call.nodeId,
        failure: cause.failure,
      });
      return false;
    }
    if (!reply.startsWith('+OK')) {
      // `-ERR No such channel` — разговор кончился сам, CDR на подходе; `-ERR NODE_REFUSED` — старый набор узла.
      this.logger.info('Узел не оборвал разговор', {
        call_id: call.id,
        node_id: call.nodeId,
        reply: reply.slice(0, 120),
      });
      return false;
    }
    const marked = await this.calls.markCutOff(call.id, 'balance_exhausted');
    this.logger.warn('Разговор оборван: у клиента закончились деньги', {
      call_id: call.id,
      client_id: call.clientId,
    });
    return marked !== undefined;
  }

  /** Стоимость каждого идущего разговора на сейчас; цена запрашивается один раз на строку цены. */
  private async priced(
    calls: readonly OpenCallSpend[],
    now: Date,
  ): Promise<SpendingCall<Id<'call'>>[]> {
    const tariffs = new Map<string, Promise<AppliedTariff>>();
    return Promise.all(
      calls.map(async (call) => {
        if (call.partnerRateId === null) {
          // Вызов до тарифов (ADR-0056): строки цены нет, и CDR его не тарифицирует по ней. Таких открытых не бывает
          // дольше предела длительности.
          return { id: call.id, cost: Money.ZERO, cutOff: call.cutOffReason !== null };
        }
        const key = `${call.partnerRateId}|${call.clientId}`;
        let applied = tariffs.get(key);
        if (applied === undefined) {
          applied = this.tariffs.resolveRate(call.partnerRateId, call.clientId, now);
          tariffs.set(key, applied);
        }
        const { rule, commission } = await applied;
        return {
          id: call.id,
          cost: chargeForCall(elapsedSeconds(call.startedAt, now), rule, commission).clientAmount,
          cutOff: call.cutOffReason !== null,
        };
      }),
    );
  }
}

function sum(calls: readonly SpendingCall<unknown>[]): MoneyAmount {
  return calls.reduce((total, call) => Money.add(total, call.cost), Money.ZERO);
}
