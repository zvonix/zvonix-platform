/**
 * Приём CDR: закрытие вызова, тарификация и списание (ADR-0010).
 *
 * Порядок действий не произволен: **сначала деньги, потом резерв, потом состояние вызова.**
 * Проводка идемпотентна по ключу, снятие резерва — условным обновлением, состояние вызова
 * перезаписывается. Поэтому повторная доставка CDR доводит до конца то, что не доделала
 * первая, и ничего не списывает дважды.
 *
 * Обратный порядок — сначала закрыть вызов — оставлял бы при сбое закрытый вызов
 * без списания: деньги потеряны, и повторная доставка их уже не найдёт.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Money, notFound, terminationKindOf, validationFailed } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { BillingService } from '../billing/billing.service.js';
import { ReservationService } from '../billing/reservation.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { LimitService } from '../limits/limit.service.js';
import { CallRepository, type CallRow } from './call.repository.js';
import { parseCdr, statusFromHangupCause, type ParsedCdr } from './cdr-parse.js';
import { TelephonyRepository } from './telephony.repository.js';

/**
 * Запас поверх предельной длительности, после которого открытый вызов считается брошенным.
 *
 * Разговор не может законно идти дольше предельной длительности: узел обрывает его сам.
 * Всё, что висит дольше вместе с запасом, — это вызов, по которому не пришёл CDR.
 * Запас нужен, чтобы не закрыть разговор, который как раз завершается: узел кладёт трубку,
 * формирует CDR и доставляет его не мгновенно.
 */
const ABANDONED_CALL_MARGIN_MS = 5 * 60 * 1000;

/** Что случилось с принятым CDR. Возвращается узлу только как код ответа. */
export type CdrOutcome =
  | { readonly kind: 'charged'; readonly call: CallRow; readonly clientAmount: string }
  | { readonly kind: 'closed'; readonly call: CallRow }
  | { readonly kind: 'ignored_b_leg' };

@Injectable()
export class CdrService {
  private readonly logger: Logger;

  constructor(
    private readonly calls: CallRepository,
    private readonly telephony: TelephonyRepository,
    private readonly tariffs: TariffService,
    private readonly billing: BillingService,
    private readonly limits: LimitService,
    private readonly reservations: ReservationService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('cdr');
  }

  async accept(body: unknown): Promise<CdrOutcome> {
    const cdr = parseCdr(body);

    const call = await this.calls.findByExternalId(cdr.uuid);
    if (call === undefined) {
      // Плечо B: у него свой `uuid`, но наш идентификатор вызова экспортирован
      // диалпланом на оба. Тарифицировать его нельзя — это тот же разговор,
      // и списание вышло бы двойным.
      if (cdr.zvonixCallId !== undefined) {
        return { kind: 'ignored_b_leg' };
      }
      throw notFound('CDR по неизвестному вызову', { details: { uuid: cdr.uuid } });
    }

    const status = statusFromHangupCause(cdr.hangupCause, cdr.billableSeconds);

    if (status !== 'completed') {
      return { kind: 'closed', call: await this.closeWithoutCharge(call, cdr, status) };
    }
    return this.charge(call, cdr);
  }

  /** Несостоявшийся разговор: резерв освобождается, деньги не движутся. */
  private async closeWithoutCharge(
    call: CallRow,
    cdr: ParsedCdr,
    status: CallRow['status'],
  ): Promise<CallRow> {
    const reservation = await this.reservations.findByCall(call.id);
    if (reservation !== undefined) {
      await this.reservations.release(call.id);
    }

    const updated = await this.calls.setStatus(call.id, status, {
      answeredAt: cdr.answeredAt ?? null,
      endedAt: cdr.endedAt ?? new Date(),
      durationSeconds: 0,
    });
    if (updated === undefined) throw notFound('Вызов не найден');
    return updated;
  }

  private async charge(call: CallRow, cdr: ParsedCdr): Promise<CdrOutcome> {
    if (call.operatorId === null || call.gatewayId === null) {
      // Состоявшийся разговор без оператора и шлюза означает, что вызов не проходил
      // через маршрутизацию. Тарифицировать его не по чему.
      throw validationFailed('У вызова нет направления или шлюза', { details: { call: call.id } });
    }

    const gateway = await this.telephony.findGateway(call.gatewayId);
    if (gateway === undefined) throw notFound('Шлюз вызова не найден');

    const channel = await this.telephony.findChannel(call.channelId);
    if (channel === undefined) throw notFound('Канал вызова не найден');

    // Цена берётся на момент **начала вызова**, а не приёма CDR: узел мог держать CDR
    // на диске, пока control plane был недоступен, и сегодняшняя цена переоценила бы
    // прошлое — это запрещено инвариантом DOMAIN.md.
    const priced = await this.tariffs.priceCall(
      gateway.partnerId,
      channel.clientId,
      { operatorId: call.operatorId, region: call.region },
      terminationKindOf(gateway.type),
      cdr.billableSeconds,
      call.startedAt,
    );

    // Минуты засчитываются в окно **начала вызова**, а не приёма CDR: узел мог держать
    // CDR на диске, и иначе разговор попал бы в чужие сутки (ADR-0026).
    const limitRules = await this.limits.rules({
      clientId: channel.clientId,
      channelId: call.channelId,
      partnerIds: [gateway.partnerId],
      ...(call.simCardId === null ? {} : { simCardIds: [call.simCardId] }),
    });

    const posted = await this.billing.chargeCall({
      callId: call.id,
      clientId: channel.clientId,
      partnerId: gateway.partnerId,
      clientAmount: priced.charge.clientAmount,
      partnerAmount: priced.charge.partnerAmount,
      commissionAmount: priced.charge.commissionAmount,
      description: `Вызов ${String(priced.charge.billedSeconds)} с`,
      occurredAt: call.startedAt,
      // Той же транзакцией, что и деньги: повторный CDR не начислит минуты дважды,
      // потому что и проводки второй раз не будет.
      alsoInTransaction: async (tx) => {
        await this.limits.consume(
          limitRules,
          'minutes',
          cdr.billableSeconds,
          call.startedAt,
          tx,
          // Разговор уже состоялся: отменить его нельзя, и проверять предел здесь
          // не по чему. Квота может быть перебрана на длительность одного вызова —
          // это принятая цена (ADR-0026).
          { verify: false },
        );
      },
    });

    const reservation = await this.reservations.findByCall(call.id);
    if (reservation !== undefined) {
      await this.reservations.capture(call.id);
    }

    const updated = await this.calls.setStatus(call.id, 'completed', {
      answeredAt: cdr.answeredAt ?? null,
      endedAt: cdr.endedAt ?? new Date(),
      durationSeconds: cdr.billableSeconds,
    });
    if (updated === undefined) throw notFound('Вызов не найден');

    if (!posted.alreadyPosted) {
      this.logger.info('Вызов тарифицирован', {
        call_id: call.id,
        billed_seconds: priced.charge.billedSeconds,
        client_amount: Money.format(priced.charge.clientAmount),
        rate_id: priced.applied.rateId,
      });
    }

    return {
      kind: 'charged',
      call: updated,
      clientAmount: Money.format(priced.charge.clientAmount),
    };
  }

  /**
   * Закрывает вызовы, по которым CDR так и не пришёл.
   *
   * Узел мог умереть посреди разговора. Тогда вызов остаётся открытым **навсегда**,
   * а открытый вызов занимает место на SIM: она числится занятой и больше не примет
   * звонков. Без этой уборки потеря одного узла постепенно выводит из оборота все SIM,
   * через которые он звонил.
   *
   * Считается по сроку, а не «с прошлого запуска»: проход идемпотентен и догоняющий,
   * пропущенный тик ничего не теряет (ADR-0020).
   *
   * Деньги здесь не движутся: резерв по такому вызову освобождается своим проходом
   * по собственному сроку, и списывать нечего — разговора мы не наблюдали.
   */
  async closeCallsWithoutCdr(now: Date = new Date()): Promise<number> {
    const deadline = new Date(
      now.getTime() - this.config.MAX_CALL_DURATION_SECONDS * 1000 - ABANDONED_CALL_MARGIN_MS,
    );
    const closed = await this.calls.closeAbandoned(deadline);
    if (closed > 0) {
      // Это не норма: рост числа таких закрытий — повод разбираться с узлом,
      // а не с вызовами.
      this.logger.warn('Закрыты вызовы без CDR, место на SIM освобождено', { count: closed });
    }
    return closed;
  }
}
