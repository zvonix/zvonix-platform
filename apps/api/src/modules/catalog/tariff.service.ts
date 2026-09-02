/**
 * Подбор тарифа и расчёт стоимости вызова (ADR-0010).
 *
 * Сам расчёт живёт в `@zvonix/shared/tariff` и базы не знает. Здесь — подбор действующих
 * правил и превращение отсутствия тарифа в отказ.
 *
 * **Отсутствие тарифа — отказ, а не бесплатный звонок.** Вызов без цены означает, что
 * платформа не знает, сколько он стоит партнёру: списать нечего, начислить нечего,
 * а партнёр всё равно тратит минуты своей SIM.
 */

import { Injectable } from '@nestjs/common';
import {
  chargeForCall,
  maxCharge,
  notFound,
  type CallCharge,
  type CommissionRule,
  type Id,
  type TariffRule,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  TariffRepository,
  type CommissionRuleRow,
  type PartnerRateRow,
} from './tariff.repository.js';

/** Направление вызова: то, что вернул резолвер. Префикс номера здесь не участвует. */
export interface Direction {
  readonly operatorId: Id<'operator'>;
  /** Регион назначения. Пусто — резолвер его не знает; подойдёт тариф без региона. */
  readonly region: string | null;
}

/** Правила, применённые к вызову. Попадают в CDR целиком: прошлое не переоценивается. */
export interface AppliedTariff {
  readonly rateId: Id<'partnerRate'>;
  readonly commissionRuleId: Id<'commissionRule'>;
  readonly rule: TariffRule;
  readonly commission: CommissionRule;
}

@Injectable()
export class TariffService {
  constructor(
    private readonly repository: TariffRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Правила, действующие для этой пары «партнёр — направление» на указанный момент.
   *
   * Момент передаётся явно, а не берётся из `Date.now()`: тарификация CDR выполняется
   * позже самого звонка, иногда сильно позже — узел мог держать CDR на диске, пока
   * control plane был недоступен. Применить к нему сегодняшнюю цену значит переоценить
   * прошлое, что запрещено инвариантом DOMAIN.md.
   */
  async resolve(
    partnerId: Id<'partner'>,
    clientId: Id<'client'>,
    direction: Direction,
    at: Date,
  ): Promise<AppliedTariff> {
    const rate = await this.repository.findPartnerRate(
      partnerId,
      direction.operatorId,
      direction.region,
      at,
    );
    if (rate === undefined) {
      throw notFound('Нет действующего тарифа партнёра по этому направлению', {
        details: {
          partner_id: partnerId,
          operator_id: direction.operatorId,
          // Подробности ошибки — значения для человека, и `null` там читается хуже,
          // чем прямое «любой»: именно так и заведён тариф без региона.
          region: direction.region ?? 'любой',
        },
      });
    }

    const commission = await this.repository.findCommissionRule(clientId, at);
    if (commission === undefined) {
      // Без наценки платформа работала бы в ноль и не знала бы об этом.
      throw notFound('Нет действующего правила наценки', { details: { client_id: clientId } });
    }

    return {
      rateId: rate.id,
      commissionRuleId: commission.id,
      rule: toTariffRule(rate),
      commission: toCommissionRule(commission),
    };
  }

  /** Стоимость состоявшегося вызова по правилам, действовавшим на его момент. */
  async priceCall(
    partnerId: Id<'partner'>,
    clientId: Id<'client'>,
    direction: Direction,
    durationSeconds: number,
    at: Date,
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied = await this.resolve(partnerId, clientId, direction, at);
    return { applied, charge: chargeForCall(durationSeconds, applied.rule, applied.commission) };
  }

  /**
   * Сколько резервировать до начала звонка.
   *
   * Стоимость разговора предельной длительности. Инвариант DOMAIN.md «баланс клиента
   * не уходит ниже разрешённого овердрафта» обеспечивается резервированием **до** звонка,
   * а не проверкой после: сто одновременных вызовов при остатке на одну минуту иначе
   * все прошли бы проверку и все состоялись.
   */
  async priceReservation(
    partnerId: Id<'partner'>,
    clientId: Id<'client'>,
    direction: Direction,
    maxDurationSeconds: number,
    at: Date,
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied = await this.resolve(partnerId, clientId, direction, at);
    return {
      applied,
      charge: maxCharge(maxDurationSeconds, applied.rule, applied.commission),
    };
  }

  async addPartnerRate(
    draft: Parameters<TariffRepository['insertPartnerRate']>[0],
    actorUserId: Id<'user'>,
    actorRole: 'admin' | 'support' | 'client' | 'partner',
  ): Promise<PartnerRateRow> {
    const row = await this.repository.insertPartnerRate(draft);
    await this.audit.record({
      action: 'partner_rate.added',
      entityType: 'partner_rate',
      entityId: row.id,
      actorUserId,
      actorRole,
      after: {
        partner_id: row.partnerId,
        operator_id: row.operatorId,
        region: row.region,
        price_per_minute: row.pricePerMinute.toString(),
        effective_from: row.effectiveFrom.toISOString(),
      },
    });
    return row;
  }

  async addCommissionRule(
    draft: Parameters<TariffRepository['insertCommissionRule']>[0],
    actorUserId: Id<'user'>,
    actorRole: 'admin' | 'support' | 'client' | 'partner',
  ): Promise<CommissionRuleRow> {
    const row = await this.repository.insertCommissionRule(draft);
    await this.audit.record({
      action: 'commission_rule.added',
      entityType: 'commission_rule',
      entityId: row.id,
      actorUserId,
      actorRole,
      after: {
        client_id: row.clientId,
        fixed_fee: row.fixedFee.toString(),
        percent_basis_points: row.percentBasisPoints.toString(),
        effective_from: row.effectiveFrom.toISOString(),
      },
    });
    return row;
  }

  async listPartnerRates(partnerId: Id<'partner'>): Promise<PartnerRateRow[]> {
    return this.repository.listPartnerRates(partnerId);
  }

  async listCommissionRules(): Promise<CommissionRuleRow[]> {
    return this.repository.listCommissionRules();
  }
}

function toTariffRule(row: PartnerRateRow): TariffRule {
  return {
    pricePerMinute: row.pricePerMinute,
    billingIncrementSeconds: row.billingIncrementSeconds,
    minimumDurationSeconds: row.minimumDurationSeconds,
    connectionFee: row.connectionFee,
    rounding: row.rounding,
  };
}

function toCommissionRule(row: CommissionRuleRow): CommissionRule {
  return { fixedFee: row.fixedFee, percentBasisPoints: row.percentBasisPoints };
}
