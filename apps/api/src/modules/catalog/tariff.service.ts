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
  Money,
  notFound,
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
import {
  TariffRepository,
  type CommissionRuleRow,
  type PartnerRateRow,
  type PriceBandRow,
} from './tariff.repository.js';

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
  readonly operatorId: Id<'operator'>;
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
  readonly band: PriceBandRow | undefined;
  /** Стоимость эталонного вызова по этому тарифу — то, чем меряется коридор. */
  readonly referenceCost: MoneyAmount;
  readonly withinBand: boolean;
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
   * Действующие цены нескольких партнёров по одному направлению — одним запросом.
   *
   * Нужна отбору кандидатов: порядок терминации зависит от цены (ADR-0040), а цена
   * лежит в тарифах. Отдаётся строка целиком, а не одно число: вызывающему нужна
   * цена за минуту, но правило принадлежит тарифу, и половина строки наружу —
   * это приглашение достроить недостающее у себя.
   */
  async effectiveRates(
    partnerIds: readonly Id<'partner'>[],
    operatorId: Id<'operator'>,
    terminationKind: TerminationKind,
    region: string | null,
    at: Date,
  ): Promise<Map<string, PartnerRateRow>> {
    return this.repository.findEffectiveRates(partnerIds, operatorId, terminationKind, region, at);
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
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied = await this.resolve(partnerId, clientId, direction, terminationKind, at);
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
    terminationKind: TerminationKind,
    maxDurationSeconds: number,
    at: Date,
  ): Promise<{ applied: AppliedTariff; charge: CallCharge }> {
    const applied = await this.resolve(partnerId, clientId, direction, terminationKind, at);
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
    // Всё одной транзакцией: запирание направлений оператора, проверка коридора,
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
      await this.assertWithinBand(draft, actorRole, tx);

      const row = await this.repository.insertPartnerRate(draft, tx);
      await this.audit.record(
        {
          action: 'partner_rate.added',
          entityType: 'partner_rate',
          entityId: row.id,
          actorUserId,
          actorRole,
          // Тариф записывается **целиком**, все пять чисел вместе со способом
          // терминации. Половина тарифа в журнале не отвечает на вопрос, ради которого
          // журнал и ведётся: спор «сколько он поставил» решается платой за соединение
          // и минимальной длительностью не меньше, чем ценой за минуту. Особенно
          // с тех пор, как цену ставит сам партнёр, а не администратор.
          after: {
            partner_id: row.partnerId,
            operator_id: row.operatorId,
            region: row.region,
            termination_kind: row.terminationKind,
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
      await this.repository.lockOperatorTariffs(draft.operatorId, tx);

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
      row.band === undefined || row.withinBand
        ? []
        : [{ rate: row.rate, band: row.band, referenceCost: row.referenceCost }],
    );
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
    const [rates, bands] = await Promise.all([
      this.repository.listActivePartnerRates(at, partnerId),
      this.repository.listActivePriceBands(at),
    ]);

    const general = new Map<string, PriceBandRow>();
    const regional = new Map<string, PriceBandRow>();
    for (const band of bands) {
      const target = band.regionKey === null ? general : regional;
      target.set(bandKey(band.operatorId, band.regionKey), band);
    }

    return rates.map((rate) => {
      // Цена без региона ограничивается только общим коридором: коридор конкретного
      // региона к направлению «любой регион» отношения не имеет.
      const band =
        (rate.regionKey === null
          ? undefined
          : regional.get(bandKey(rate.operatorId, rate.regionKey))) ??
        general.get(bandKey(rate.operatorId, null));

      const cost = referenceCost(toTariffRule(rate));
      return {
        rate,
        band,
        referenceCost: cost,
        // Коридора нет — ограничения нет: цена в него укладывается по определению.
        withinBand:
          band === undefined ||
          (Money.compare(cost, band.minPrice) >= 0 && Money.compare(cost, band.maxPrice) <= 0),
      };
    });
  }

  /**
   * Цена обязана укладываться в коридор, действующий по этому направлению.
   *
   * Сравнивается **стоимость эталонного вызова**, а не цена за минуту: тариф — это пять
   * чисел, и коридор, ограничивающий одно из них, обходится платой за соединение или
   * минимальной длительностью в десять минут (ADR-0023). Коридора нет — ограничения нет.
   */
  private async assertWithinBand(
    draft: Parameters<TariffRepository['insertPartnerRate']>[0],
    actorRole: UserRole,
    executor: Executor,
  ): Promise<void> {
    const band = await this.repository.findPriceBand(
      draft.operatorId,
      draft.region,
      draft.effectiveFrom,
      executor,
    );

    if (band === undefined) {
      // «Коридора нет — ограничения нет» верно ровно до того дня, когда цену назначает
      // не тот, кто задаёт коридор. Условие пересмотра названо в ADR-0023 прямо:
      // обработчик партнёра обязан отказывать в цене по направлению без коридора,
      // иначе правило становится добровольным для той стороны, ради ограничения
      // которой заведено. Администратору запрет не нужен — он и есть тот, кто коридор
      // задаёт, и запрет запер бы открытие нового направления в круг.
      if (actorRole === 'admin') return;
      throw validationFailed('По этому направлению не задан коридор цен', {
        details: {
          operator_id: draft.operatorId,
          region: draft.region ?? 'любой регион',
          // Не «попробуйте иначе», а «здесь решает площадка»: сам партнёр коридор
          // не заводит, и без этой строки отказ читается как его собственная ошибка.
          remedy: 'Коридор по направлению задаёт площадка — попросите её открыть его',
        },
      });
    }

    const cost = referenceCost({
      pricePerMinute: draft.pricePerMinute,
      billingIncrementSeconds: draft.billingIncrementSeconds,
      minimumDurationSeconds: draft.minimumDurationSeconds,
      connectionFee: draft.connectionFee,
      rounding: draft.rounding,
    });

    if (Money.compare(cost, band.minPrice) < 0 || Money.compare(cost, band.maxPrice) > 0) {
      throw validationFailed('Цена вне коридора, заданного для этого направления', {
        details: {
          reference_call_seconds: REFERENCE_CALL_SECONDS,
          // Именно стоимость эталонного вызова, а не цена за минуту: у тарифа с платой
          // за соединение это разные числа, и показать не то значит оставить человека
          // с вопросом «почему 2 рубля не помещаются в коридор от 1 до 3».
          reference_cost: Money.format(cost),
          min_price: Money.format(band.minPrice),
          max_price: Money.format(band.maxPrice),
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

/** Ключ направления для сопоставления коридоров с ценами в памяти. */
function bandKey(operatorId: Id<'operator'>, regionKey: string | null): string {
  // Идентификатор оператора — UUID постоянной длины, поэтому разделитель
  // не может склеить два разных направления в один ключ.
  return `${operatorId}|${regionKey ?? ''}`;
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
