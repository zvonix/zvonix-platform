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
  conflict,
  DomainError,
  maxCharge,
  Money,
  notFound,
  regionKeysOf,
  referenceCost,
  REFERENCE_CALL_SECONDS,
  validationFailed,
  type CallCharge,
  type CommissionRule,
  type Id,
  type MoneyAmount,
  type Rounding,
  type TariffRule,
  type TerminationKind,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import type { Executor } from '@zvonix/db';
import { SettingsService } from '../settings/settings.service.js';
import {
  TariffRepository,
  type CommissionRuleRow,
  type PartnerRateRow,
  type PartnerTariffRow,
  type PriceBandRow,
} from './tariff.repository.js';

/** Кто меняет тарифы: для журнала. Пусто у пользователя не бывает — решает человек. */
interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

/**
 * Запрос цены одного кандидата: его партнёр, его тариф (пусто — тариф партнёра
 * по умолчанию) и способ терминации ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)).
 */
export interface RateRequest {
  readonly partnerId: Id<'partner'>;
  readonly tariffId: Id<'partnerTariff'> | null;
  readonly terminationKind: TerminationKind;
}

/**
 * Цена предложения партнёра для клиента — диапазоном по всем его направлениям.
 *
 * Партнёр назван идентификатором: превращение его в псевдоним — забота обработчика,
 * который решает, кому отдаёт ответ ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 */
export interface OfferPrice {
  readonly partnerId: Id<'partner'>;
  readonly terminationKind: TerminationKind;
  readonly minPrice: MoneyAmount;
  readonly maxPrice: MoneyAmount;
  readonly directions: number;
}

/**
 * Длительности, на которых показывается стоимость вызова.
 *
 * Не круглые числа ради красоты: короткий вызов — то место, где посекундный тариф
 * расходится с поминутным в разы, и без него сравнение по «цене за минуту» вводит
 * в заблуждение ровно там, где решает.
 */
const EXAMPLE_DURATIONS = [15, 30, 60] as const;

/**
 * Стоимость вызова названной длительности для клиента.
 *
 * Наружу не выносится: потребитель берёт её из `ClientTariff`, а отдельное имя означало бы
 * второй способ сказать то же самое.
 */
interface TariffExample {
  readonly seconds: number;
  readonly amount: MoneyAmount;
}

/**
 * Состав цены по одному направлению одного предложения — так, как его видит клиент.
 *
 * Партнёр назван идентификатором: превращение его в псевдоним — забота обработчика,
 * который решает, кому отдаёт ответ ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 */
export interface ClientTariff {
  readonly partnerId: Id<'partner'>;
  readonly terminationKind: TerminationKind;
  /** Пусто — цена на все операторы (ADR-0056). */
  readonly operatorId: Id<'operator'> | null;
  readonly region: string | null;
  /** Шаг тарификации: единица — посекундно, шестьдесят — поминутно. */
  readonly billingIncrementSeconds: number;
  readonly minimumDurationSeconds: number;
  readonly pricePerMinute: MoneyAmount;
  readonly connectionFee: MoneyAmount;
  readonly examples: readonly TariffExample[];
}

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

/**
 * Действующая цена, оказавшаяся вне действующего коридора (ADR-0023).
 *
 * Возникает не от ошибки при вводе, а от **сужения коридора после** назначения цены:
 * строка тарифа неизменяема, и переписывать её значило бы переоценивать прошлое. Без
 * этого списка правило тихо перестало бы выполняться, и узнать об этом было бы неоткуда.
 */
/**
 * Действующая цена вместе с коридором своего направления.
 *
 * Коридора может не быть: он задаётся не по всем направлениям, и его отсутствие
 * означает «ограничения нет», а не «цена вне рамок».
 */
export interface RateWithBand {
  readonly rate: PartnerRateRow;
  /**
   * Рамки цены: коридор её направления, а у цены «на все операторы» — пересечение
   * коридоров всех операторов (ADR-0056). Пусто — коридора нет или коридоры отключены.
   */
  readonly limits: BandLimits | undefined;
  /** Стоимость эталонного вызова по этому тарифу — то, чем меряется коридор. */
  readonly referenceCost: MoneyAmount;
  readonly withinBand: boolean;
  /** Первый коридор, в который цена не уложилась. */
  readonly violated: PriceBandRow | undefined;
}

export interface BandLimits {
  readonly minPrice: MoneyAmount;
  readonly maxPrice: MoneyAmount;
}

export interface BandViolation {
  readonly rate: PartnerRateRow;
  readonly band: PriceBandRow;
  readonly referenceCost: MoneyAmount;
}

@Injectable()
export class TariffService {
  constructor(
    private readonly repository: TariffRepository,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
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
    terminationKind: TerminationKind,
    at: Date,
  ): Promise<AppliedTariff> {
    const rate = await this.repository.findPartnerRate(
      partnerId,
      direction.operatorId,
      terminationKind,
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
          termination_kind: terminationKind,
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

  /**
   * Действующая цена каждого кандидата по его тарифу — одним запросом на способ
   * терминации ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)).
   *
   * Тариф кандидата без своего — тариф его партнёра по умолчанию. Ответ — по позиции
   * запроса; пусто — цены по направлению в тарифе нет, и звонить через кандидата нельзя
   * (ADR-0040): тарифицировать будет нечем.
   */
  async ratesFor(
    requests: readonly RateRequest[],
    operatorId: Id<'operator'>,
    region: string | null,
    at: Date,
  ): Promise<(PartnerRateRow | undefined)[]> {
    const defaults = await this.repository.defaultTariffs([
      ...new Set(requests.filter((r) => r.tariffId === null).map((r) => r.partnerId)),
    ]);
    const tariffOf = (request: RateRequest): Id<'partnerTariff'> | undefined =>
      request.tariffId ?? defaults.get(request.partnerId);

    const kinds = [...new Set(requests.map((request) => request.terminationKind))];
    const byKind = new Map(
      await Promise.all(
        kinds.map(async (kind) => {
          const tariffIds = [
            ...new Set(
              requests
                .filter((request) => request.terminationKind === kind)
                .map(tariffOf)
                .filter((id): id is Id<'partnerTariff'> => id !== undefined),
            ),
          ];
          const rates = await this.repository.findEffectiveRatesByTariffs(
            tariffIds,
            operatorId,
            kind,
            region,
            at,
          );
          return [kind, rates] as const;
        }),
      ),
    );

    return requests.map((request) => {
      const tariffId = tariffOf(request);
      return tariffId === undefined
        ? undefined
        : byKind.get(request.terminationKind)?.get(tariffId);
    });
  }

  /**
   * Правила по строке цены, выбранной при маршрутизации (ADR-0056): цена вызова
   * не зависит от того, что тариф SIM сменили посреди разговора. Наценка — на момент `at`.
   */
  async resolveRate(
    rateId: Id<'partnerRate'>,
    clientId: Id<'client'>,
    at: Date,
  ): Promise<AppliedTariff> {
    const rate = await this.repository.findRate(rateId);
    if (rate === undefined) {
      throw notFound('Строка цены вызова не найдена', { details: { partner_rate_id: rateId } });
    }
    const commission = await this.repository.findCommissionRule(clientId, at);
    if (commission === undefined) {
      throw notFound('Нет действующего правила наценки', { details: { client_id: clientId } });
    }
    return {
      rateId: rate.id,
      commissionRuleId: commission.id,
      rule: toTariffRule(rate),
      commission: toCommissionRule(commission),
    };
  }

  /**
   * Во что клиенту обходятся предложения партнёров — диапазоном по каждому.
   *
   * Считается **стоимость эталонного вызова в 60 секунд**, а не цена за минуту: тариф
   * это пять чисел, и сравнение по одному из них ставит рядом предложения, которые
   * на деле стоят по-разному ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)
   * меряет коридор той же величиной).
   *
   * Цена **клиента**, а не партнёра: наценка платформы уже внутри. Порядок предложений
   * от этого не меняется — наценка зависит от клиента, а не от партнёра, — но человеку
   * показывается то число, которое он заплатит.
   */
  async offerPrices(
    clientId: Id<'client'>,
    partnerIds: readonly Id<'partner'>[],
    operatorId: Id<'operator'> | undefined,
    seconds: number,
    at: Date,
  ): Promise<OfferPrice[]> {
    const commission = await this.repository.findCommissionRule(clientId, at);
    if (commission === undefined) {
      // Без наценки цены нет вовсе: платформа не знает, во что вызов обойдётся клиенту.
      throw notFound('Нет действующего правила наценки', { details: { client_id: clientId } });
    }

    const rates = await this.repository.listEffectiveRates(partnerIds, operatorId, at);
    const rule = toCommissionRule(commission);
    const byOffer = new Map<string, { offer: OfferPrice; prices: MoneyAmount[] }>();

    for (const rate of rates) {
      const cost = chargeForCall(seconds, toTariffRule(rate), rule).clientAmount;
      const key = `${rate.partnerId}:${rate.terminationKind}`;
      const seen = byOffer.get(key);
      if (seen === undefined) {
        byOffer.set(key, {
          offer: {
            partnerId: rate.partnerId,
            terminationKind: rate.terminationKind,
            minPrice: cost,
            maxPrice: cost,
            directions: 1,
          },
          prices: [cost],
        });
        continue;
      }
      seen.prices.push(cost);
      seen.offer = {
        ...seen.offer,
        minPrice: cost < seen.offer.minPrice ? cost : seen.offer.minPrice,
        maxPrice: cost > seen.offer.maxPrice ? cost : seen.offer.maxPrice,
        directions: seen.prices.length,
      };
    }

    // Дешёвое сверху: список открывают, чтобы понять, кто дешевле, а не чтобы читать
    // его целиком.
    return [...byOffer.values()]
      .map((entry) => entry.offer)
      .sort((left, right) =>
        left.minPrice === right.minPrice ? 0 : left.minPrice < right.minPrice ? -1 : 1,
      );
  }

  /**
   * Из чего складывается цена — по каждому направлению каждого предложения.
   *
   * Диапазон в `offerPrices` отвечает «кто дешевле», а этот список — «почему столько».
   * Разница между ними существеннее, чем кажется: два тарифа по 2 ₽ за минуту, один
   * посекундный, другой поминутный, на вызове в 60 секунд стоят одинаково, а на вызове
   * в 20 секунд — втрое по-разному. Для службы такси, где вызов «машина у подъезда»
   * длится полминуты, решает именно это.
   *
   * Поэтому вместе с составом отдаётся **стоимость нескольких длительностей**: одно
   * число сравнивает тарифы там, где они не сравнимы одним числом.
   *
   * Суммы — клиентские, с наценкой площадки внутри. Шаг и минимум — структура тарифа,
   * они одинаковы у обеих сторон.
   */
  async clientTariffs(
    clientId: Id<'client'>,
    partnerIds: readonly Id<'partner'>[],
    operatorId: Id<'operator'> | undefined,
    at: Date,
  ): Promise<ClientTariff[]> {
    const commission = await this.repository.findCommissionRule(clientId, at);
    if (commission === undefined) {
      throw notFound('Нет действующего правила наценки', { details: { client_id: clientId } });
    }

    const rates = await this.repository.listEffectiveRates(partnerIds, operatorId, at);
    const rule = toCommissionRule(commission);

    return rates.map((rate) => {
      const tariff = toTariffRule(rate);
      return {
        partnerId: rate.partnerId,
        terminationKind: rate.terminationKind,
        operatorId: rate.operatorId,
        region: rate.region,
        billingIncrementSeconds: rate.billingIncrementSeconds,
        minimumDurationSeconds: rate.minimumDurationSeconds,
        // Цена минуты и плата за соединение — с наценкой, чтобы клиент видел свои числа.
        // Итог по длительности при этом считается отдельно и точно: наценка округляется
        // один раз на всю сумму вызова, а не по частям, и сложение частей дало бы копейку
        // расхождения.
        pricePerMinute: withCommission(rate.pricePerMinute, rule, rate.rounding),
        connectionFee: Money.isZero(rate.connectionFee)
          ? rule.fixedFee
          : Money.add(withCommission(rate.connectionFee, rule, rate.rounding), rule.fixedFee),
        examples: EXAMPLE_DURATIONS.map((durationSeconds) => ({
          seconds: durationSeconds,
          amount: chargeForCall(durationSeconds, tariff, rule).clientAmount,
        })),
      };
    });
  }

  /** Стоимость состоявшегося вызова по правилам, действовавшим на его момент. */
  async priceCall(
    partnerId: Id<'partner'>,
    clientId: Id<'client'>,
    direction: Direction,
    terminationKind: TerminationKind,
    durationSeconds: number,
    at: Date,
    /** Строка цены, выбранная при маршрутизации; пусто — вызов до тарифов (ADR-0056). */
    rateId: Id<'partnerRate'> | null = null,
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied =
      rateId === null
        ? await this.resolve(partnerId, clientId, direction, terminationKind, at)
        : await this.resolveRate(rateId, clientId, at);
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
    rateId: Id<'partnerRate'>,
    clientId: Id<'client'>,
    maxDurationSeconds: number,
    at: Date,
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied = await this.resolveRate(rateId, clientId, at);
    return {
      applied,
      charge: maxCharge(maxDurationSeconds, applied.rule, applied.commission),
    };
  }

  async addPartnerRate(
    draft: Parameters<TariffRepository['insertPartnerRate']>[0],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<PartnerRateRow> {
    // Всё одной транзакцией: запирание направлений, проверка тарифа и коридора,
    // вставка и запись в журнал.
    //
    // Коридор — [ADR-0023](../../../../../docs/adr/0023-koridory-cen.md): проверка вне
    // транзакции оставляла окно, в котором коридор успевал сузиться между чтением
    // и вставкой, и цена оказывалась снаружи ограничения, которое её пропустило.
    //
    // Журнал — [ADR-0034](../../../../../docs/adr/0034-zhurnal-deneg-odnoy-tranzakciey.md):
    // спор «кто поднял цену и когда» разбирается по нему, и цена без записи в журнале —
    // цена без автора.
    return this.repository.pool.transaction(async (tx) => {
      await this.repository.lockOperatorTariffs(draft.operatorId, tx);
      // Тариф чужого партнёра — не его цена: проверка в той же транзакции, что вставка.
      const tariff = await this.repository.findTariff(draft.tariffId, tx);
      if (tariff?.partnerId !== draft.partnerId) {
        throw notFound('Тариф не найден', { details: { tariff_id: draft.tariffId } });
      }
      await this.assertWithinBand(draft, tx);

      const row = await this.repository.insertPartnerRate(draft, tx);
      await this.audit.record(
        {
          action: 'partner_rate.added',
          entityType: 'partner_rate',
          entityId: row.id,
          actorUserId,
          actorRole,
          after: {
            partner_id: row.partnerId,
            tariff_id: row.tariffId,
            tariff_name: tariff.name,
            operator_id: row.operatorId,
            termination_kind: row.terminationKind,
            region: row.region,
            price_per_minute: row.pricePerMinute.toString(),
            billing_increment_seconds: row.billingIncrementSeconds,
            minimum_duration_seconds: row.minimumDurationSeconds,
            connection_fee: row.connectionFee.toString(),
            rounding: row.rounding,
            effective_from: row.effectiveFrom.toISOString(),
          },
        },
        tx,
      );
      return row;
    });
  }

  // --- Тарифы партнёра (ADR-0056) ----------------------------------------------

  /** Тарифы партнёра; тариф по умолчанию заводится, если его ещё нет. */
  async listTariffs(partnerId: Id<'partner'>): Promise<PartnerTariffRow[]> {
    await this.repository.ensureDefaultTariff(partnerId);
    return this.repository.listTariffs(partnerId);
  }

  /** Тариф по умолчанию — к нему пишется цена, если тариф не назван. */
  async defaultTariff(partnerId: Id<'partner'>): Promise<PartnerTariffRow> {
    return this.repository.ensureDefaultTariff(partnerId);
  }

  /**
   * Тариф этого партнёра — или отказ. Зовут те, кто привязывает тариф к шлюзу или SIM:
   * чужой тариф — это чужие цены на своей карте.
   */
  async requireTariffOf(
    partnerId: Id<'partner'>,
    tariffId: Id<'partnerTariff'>,
    executor?: Executor,
  ): Promise<PartnerTariffRow> {
    const tariff = await this.repository.findTariff(tariffId, executor);
    if (tariff?.partnerId !== partnerId) {
      throw notFound('Тариф не найден', { details: { tariff_id: tariffId } });
    }
    return tariff;
  }

  async createTariff(
    partnerId: Id<'partner'>,
    name: string,
    actor: Actor,
  ): Promise<PartnerTariffRow> {
    return this.repository.pool.transaction(async (tx) => {
      await this.repository.ensureDefaultTariff(partnerId, tx);
      const row = await this.repository.insertTariff({ partnerId, name }, tx);
      await this.recordTariff('partner_tariff.created', row, actor, undefined, tx);
      return row;
    });
  }

  /**
   * Переименовать и (или) сделать тарифом по умолчанию. Снять «по умолчанию» нельзя —
   * только назначить другой: без него SIM без тарифа осталась бы без цен.
   */
  async updateTariff(
    partnerId: Id<'partner'>,
    tariffId: Id<'partnerTariff'>,
    change: { name?: string | undefined; isDefault?: true | undefined },
    actor: Actor,
  ): Promise<PartnerTariffRow> {
    return this.repository.pool.transaction(async (tx) => {
      await this.repository.lockPartnerTariffs(partnerId, tx);
      const before = await this.requireTariffOf(partnerId, tariffId, tx);
      if (change.name !== undefined && change.name !== before.name) {
        await this.repository.renameTariff(tariffId, change.name, tx);
      }
      if (change.isDefault === true && !before.isDefault) {
        await this.repository.makeDefaultTariff(partnerId, tariffId, tx);
      }
      const after = await this.requireTariffOf(partnerId, tariffId, tx);
      await this.recordTariff('partner_tariff.updated', after, actor, before, tx);
      return after;
    });
  }

  /**
   * Удалить тариф с его ценами. Нельзя удалить тариф по умолчанию, выбранный у шлюза
   * или SIM и тот, по чьей цене уже был вызов: это держат внешние ключи.
   */
  async deleteTariff(
    partnerId: Id<'partner'>,
    tariffId: Id<'partnerTariff'>,
    actor: Actor,
  ): Promise<void> {
    await this.repository.pool.transaction(async (tx) => {
      await this.repository.lockPartnerTariffs(partnerId, tx);
      const before = await this.requireTariffOf(partnerId, tariffId, tx);
      if (before.isDefault) {
        throw conflict('Тариф по умолчанию не удаляется — сначала назначьте другой', {
          details: { tariff_id: tariffId },
        });
      }
      try {
        await this.repository.deleteTariff(tariffId, tx);
      } catch (cause) {
        if (cause instanceof DomainError && cause.code === 'conflict') {
          throw conflict(
            'Тариф используется: он выбран у шлюза или SIM, или по его цене уже были звонки',
            { details: { tariff_id: tariffId } },
          );
        }
        throw cause;
      }
      await this.recordTariff('partner_tariff.deleted', undefined, actor, before, tx);
    });
  }

  private async recordTariff(
    action: string,
    after: PartnerTariffRow | undefined,
    actor: Actor,
    before: PartnerTariffRow | undefined,
    tx: Executor,
  ): Promise<void> {
    const view = (row: PartnerTariffRow) => ({
      partner_id: row.partnerId,
      name: row.name,
      is_default: row.isDefault,
    });
    const subject = after ?? before;
    if (subject === undefined) return;
    await this.audit.record(
      {
        action,
        entityType: 'partner_tariff',
        entityId: subject.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        ...(before === undefined ? {} : { before: view(before) }),
        ...(after === undefined ? {} : { after: view(after) }),
      },
      tx,
    );
  }

  async addCommissionRule(
    draft: Parameters<TariffRepository['insertCommissionRule']>[0],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<CommissionRuleRow> {
    return this.repository.pool.transaction(async (tx) => {
      const row = await this.repository.insertCommissionRule(draft, tx);
      await this.audit.record(
        {
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
        },
        tx,
      );
      return row;
    });
  }

  // --- Коридоры цен (ADR-0023) -------------------------------------------------

  async addPriceBand(
    draft: Parameters<TariffRepository['insertPriceBand']>[0],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<PriceBandRow> {
    return this.repository.pool.transaction(async (tx) => {
      // Та же очередь, что и у записи цены: иначе сужение коридора проскакивало бы
      // между её проверкой и вставкой (ADR-0023).
      await this.repository.lockOperatorTariffs(draft.operatorId, tx, 'band');

      const row = await this.repository.insertPriceBand(draft, tx);
      await this.audit.record(
        {
          action: 'price_band.added',
          entityType: 'price_band',
          entityId: row.id,
          actorUserId,
          actorRole,
          after: {
            operator_id: row.operatorId,
            region: row.region,
            min_price: row.minPrice.toString(),
            max_price: row.maxPrice.toString(),
            effective_from: row.effectiveFrom.toISOString(),
          },
        },
        tx,
      );
      return row;
    });
  }

  /**
   * Действующие общие коридоры — по одному на оператора, без региона.
   *
   * Нужны там, где цену **ещё только собираются назначить**: без рамок рядом с полем
   * человек вводит число вслепую и узнаёт о коридоре из отказа. Региональные коридоры
   * сюда не входят намеренно — они относятся к конкретному региону, и показывать их
   * как общие значило бы назвать не те границы.
   */
  async generalBands(at: Date): Promise<Map<string, PriceBandRow>> {
    const bands = await this.repository.listActivePriceBands(at);
    return new Map(
      bands.filter((band) => band.regionKey === null).map((band) => [band.operatorId, band]),
    );
  }

  async listPriceBands(operatorId?: Id<'operator'>): Promise<PriceBandRow[]> {
    return this.repository.listPriceBands(operatorId);
  }

  /**
   * Действующие цены, оказавшиеся вне действующего коридора.
   *
   * Считается в памяти, а не запросом: стоимость эталонного вызова обязана считаться
   * **той же функцией**, которой считается настоящий вызов, — формула, переписанная
   * в SQL, проверяла бы не то, за что заплатит клиент (ADR-0023).
   */
  async findBandViolations(at: Date): Promise<BandViolation[]> {
    const rows = await this.ratesWithBands(at);
    return rows.flatMap((row) =>
      row.violated === undefined
        ? []
        : [{ rate: row.rate, band: row.violated, referenceCost: row.referenceCost }],
    );
  }

  /** Проверяются ли коридоры вовсе — настройка площадки (ADR-0056). */
  async bandsEnabled(): Promise<boolean> {
    return (await this.settings.pricing()).priceBandsEnabled;
  }

  /**
   * Действующие цены рядом с коридорами, которые их ограничивают.
   *
   * Один проход на два потребителя: разбор нарушений у администратора и кабинет
   * партнёра, где цена без коридора рядом не читается — партнёр не видит, куда ему
   * можно двигаться. Сравнение считается **в памяти той же функцией**, которой
   * считается настоящий вызов: формула, переписанная в SQL, проверяла бы не то,
   * за что заплатит клиент (ADR-0023).
   */
  async ratesWithBands(at: Date, partnerId?: Id<'partner'>): Promise<RateWithBand[]> {
    const [rates, bands, enabled] = await Promise.all([
      this.repository.listActivePartnerRates(at, partnerId),
      this.repository.listActivePriceBands(at),
      this.bandsEnabled(),
    ]);

    return rates.map((rate) => {
      const cost = referenceCost(toTariffRule(rate));
      const applicable = enabled
        ? applicableBands(rate.operatorId, rate.regionKey === null ? [] : [rate.regionKey], bands)
        : [];
      return {
        rate,
        limits: limitsOf(applicable),
        referenceCost: cost,
        violated: applicable.find((band) => !fits(cost, band)),
        // Коридора нет — ограничения нет: цена в него укладывается по определению.
        withinBand: applicable.every((band) => fits(cost, band)),
      };
    });
  }

  /**
   * Цена обязана укладываться в коридоры, действующие по её направлению.
   *
   * Сравнивается **стоимость эталонного вызова**, а не цена за минуту: тариф — это пять
   * чисел, и коридор, ограничивающий одно из них, обходится платой за соединение или
   * минимальной длительностью в десять минут (ADR-0023).
   *
   * **Коридора нет — ограничения нет**, и для партнёра тоже: коридор — рамка, которую
   * площадка ставит там, где хочет, а не пропуск; коридоры можно и отключить вовсе
   * настройкой (владелец, 2026-09-25; ADR-0056). Цена «на все операторы» обязана
   * уложиться в коридор **каждого** оператора — иначе через неё обходился бы коридор
   * любого из них.
   */
  private async assertWithinBand(
    draft: Parameters<TariffRepository['insertPartnerRate']>[0],
    executor: Executor,
  ): Promise<void> {
    if (!(await this.bandsEnabled())) return;
    const bands = await this.repository.listActivePriceBands(draft.effectiveFrom, executor);
    const applicable = applicableBands(draft.operatorId, regionKeysOf(draft.region), bands);

    const cost = referenceCost({
      pricePerMinute: draft.pricePerMinute,
      billingIncrementSeconds: draft.billingIncrementSeconds,
      minimumDurationSeconds: draft.minimumDurationSeconds,
      connectionFee: draft.connectionFee,
      rounding: draft.rounding,
    });

    const band = applicable.find((candidate) => !fits(cost, candidate));
    if (band !== undefined) {
      throw validationFailed('Цена вне коридора, заданного для этого направления', {
        details: {
          reference_call_seconds: REFERENCE_CALL_SECONDS,
          // Именно стоимость эталонного вызова, а не цена за минуту: у тарифа с платой
          // за соединение это разные числа, и показать не то значит оставить человека
          // с вопросом «почему 2 рубля не помещаются в коридор от 1 до 3».
          reference_cost: Money.format(cost),
          min_price: Money.format(band.minPrice),
          max_price: Money.format(band.maxPrice),
          operator_id: band.operatorId,
          price_band_id: band.id,
        },
      });
    }
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

function fits(cost: MoneyAmount, band: PriceBandRow): boolean {
  return Money.compare(cost, band.minPrice) >= 0 && Money.compare(cost, band.maxPrice) <= 0;
}

/**
 * Коридоры, ограничивающие цену (ADR-0023, ADR-0056).
 *
 * У каждого оператора — один: региональный, если регион цены совпал, иначе общий;
 * среди подошедших региональных — самый свежий. Цена без региона ограничивается только
 * общими: коридор конкретного региона к направлению «любой регион» отношения не имеет.
 * У цены с оператором — коридор этого оператора, у цены «на все» — каждого.
 */
function applicableBands(
  operatorId: Id<'operator'> | null,
  regionKeys: readonly string[],
  bands: readonly PriceBandRow[],
): PriceBandRow[] {
  const byOperator = new Map<string, { general?: PriceBandRow; regional?: PriceBandRow }>();
  for (const band of bands) {
    if (operatorId !== null && band.operatorId !== operatorId) continue;
    const entry = byOperator.get(band.operatorId) ?? {};
    if (band.regionKey === null) {
      entry.general = band;
    } else if (
      regionKeys.includes(band.regionKey) &&
      (entry.regional === undefined || band.effectiveFrom > entry.regional.effectiveFrom)
    ) {
      entry.regional = band;
    }
    byOperator.set(band.operatorId, entry);
  }
  return [...byOperator.values()].flatMap((entry) => {
    const band = entry.regional ?? entry.general;
    return band === undefined ? [] : [band];
  });
}

/** Общие рамки нескольких коридоров — их пересечение. */
function limitsOf(bands: readonly PriceBandRow[]): BandLimits | undefined {
  if (bands.length === 0) return undefined;
  let minPrice = bands[0]?.minPrice ?? Money.ZERO;
  let maxPrice = bands[0]?.maxPrice ?? Money.ZERO;
  for (const band of bands) {
    if (Money.compare(band.minPrice, minPrice) > 0) minPrice = band.minPrice;
    if (Money.compare(band.maxPrice, maxPrice) < 0) maxPrice = band.maxPrice;
  }
  return { minPrice, maxPrice };
}

/**
 * Сумма партнёра с процентом площадки.
 *
 * Фиксированная часть наценки сюда не входит: она берётся **за вызов**, а не за минуту,
 * и прибавление её к цене минуты означало бы, что десятиминутный разговор платит её
 * десять раз.
 */
function withCommission(
  amount: MoneyAmount,
  commission: CommissionRule,
  rounding: Rounding,
): MoneyAmount {
  return Money.add(amount, Money.applyBasisPoints(amount, commission.percentBasisPoints, rounding));
}
