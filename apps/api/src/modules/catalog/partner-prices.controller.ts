/**
 * Свои цены так, как их видит **сам партнёр**.
 *
 * До этого обработчика партнёр не знал, по какой цене продаёт: цены заводит
 * администратор, и единственный способ их прочитать начинался с `partnerId` в адресе.
 * Партнёр, не знающий своей цены, не может ни спорить о начислении, ни понять,
 * почему через него не идут вызовы.
 *
 * Коридор отдаётся **рядом с ценой**, а не отдельным списком: без него число на экране
 * не говорит ничего о том, куда можно двигаться, а разговор о цене — это разговор
 * о рамках ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 */

import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  Money,
  parseId,
  permissionDenied,
  REFERENCE_CALL_SECONDS,
  type Rounding,
  type TerminationKind,
} from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { CatalogService } from './catalog.service.js';
import { partnerOwnRateSchema } from './schemas.js';
import { TariffService, type RateWithBand } from './tariff.service.js';
import { toRateView, type RateView } from './views.js';

/**
 * Цена партнёра по одному направлению.
 *
 * Направление — это оператор, регион **и способ терминации**
 * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)):
 * у партнёра с SIM и транком по одному оператору две разные цены, и сводить их
 * в одну строку было бы неправдой.
 *
 * `reference_cost` — стоимость эталонного вызова по этому тарифу. Именно она
 * сравнивается с коридором: тариф это пять чисел, и коридор, ограничивающий одну
 * лишь цену за минуту, обходится платой за соединение.
 */
interface PricedDirectionView {
  readonly id: string;
  readonly operator_id: string;
  readonly operator_name: string | null;
  readonly region: string | null;
  readonly termination_kind: TerminationKind;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: Rounding;
  readonly effective_from: string;
  readonly reference_cost: string;
  readonly band: { min_price: string; max_price: string } | null;
  /** Уложилась ли цена в коридор. Коридора нет — уложилась по определению. */
  readonly within_band: boolean;
}

/** Оператор, по которому у партнёра нет ни одной цены. */
interface UncoveredView {
  readonly operator_id: string;
  readonly operator_name: string;
}

/**
 * Направление, открытое площадкой, — и рамки, в которые обязана уложиться цена.
 *
 * Отдельным списком, а не полем при цене: у цены стоит **её собственный** коридор,
 * который для региональной цены может быть региональным. Показывать его как рамки
 * для новой цены «на любой регион» значило бы назвать не те границы. Здесь всегда
 * общий коридор направления — тот, что применится, если региональный не задан.
 *
 * Оператора нет в этом списке — цену по нему назначить нельзя вовсе: коридор задаёт
 * площадка, и сказать об этом до отправки формы честнее, чем отказом после.
 */
interface OpenDirectionView {
  readonly operator_id: string;
  readonly operator_name: string;
  readonly min_price: string;
  readonly max_price: string;
}

@Controller()
export class PartnerPricesController {
  constructor(
    private readonly tariffs: TariffService,
    private readonly catalog: CatalogService,
    private readonly billing: BillingService,
  ) {}

  /**
   * По какой цене я продаю и в каких рамках.
   *
   * Вместе с ценами отдаются операторы, по которым цены нет вовсе: кандидат без
   * действующей цены по направлению в перебор не попадает **вообще** (ADR-0040),
   * то есть пустая строка в этом списке — это ёмкость, которая никогда не получит
   * ни одного вызова. Для партнёра это самый дорогой из невидимых отказов.
   *
   * Неподтверждённые операторы в этот список не попадают: по ним вызов не совершается
   * ни у кого ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)),
   * и цена там ничего не изменила бы.
   */
  @Cabinets('partner')
  @Get('partner/rates')
  async rates(@CurrentUser() actor: Principal): Promise<{
    reference_call_seconds: number;
    rates: PricedDirectionView[];
    operators_without_price: UncoveredView[];
    open_directions: OpenDirectionView[];
  }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const at = new Date();
    const [rows, verified, bands] = await Promise.all([
      this.tariffs.ratesWithBands(at, partner.id),
      this.catalog.verifiedOperators(),
      this.tariffs.generalBands(at),
    ]);

    // Имена — только для тех операторов, у кого цена есть: справочник наполнен планом
    // нумерации и содержит сотни записей, а брать его целиком ради десятка строк дорого.
    // Цена может стоять и на неподтверждённом операторе, поэтому имена берутся отдельно
    // от списка подтверждённых.
    const names = await this.catalog.operatorNamesOf(rows.map((row) => row.rate.operatorId));
    const priced = new Set<string>(rows.map((row) => row.rate.operatorId));

    return {
      // Длительность эталонного вызова отдаётся вместе с ценами: без неё непонятно,
      // что за число стоит рядом с коридором.
      reference_call_seconds: REFERENCE_CALL_SECONDS,
      rates: rows.map((row) => toPricedDirection(row, names)),
      operators_without_price: verified
        .filter((operator) => !priced.has(operator.id))
        .map((operator) => ({ operator_id: operator.id, operator_name: operator.name })),
      // Все открытые направления, а не только незаполненные: цену меняют и там,
      // где она уже есть, и рамки нужны в обоих случаях.
      open_directions: verified.flatMap((operator) => {
        const band = bands.get(operator.id);
        return band === undefined
          ? []
          : [
              {
                operator_id: operator.id,
                operator_name: operator.name,
                min_price: Money.format(band.minPrice),
                max_price: Money.format(band.maxPrice),
              },
            ];
      }),
    };
  }

  /**
   * Назначить себе цену по направлению.
   *
   * Первое, что партнёр в этой площадке меняет сам. До него цены заводил администратор,
   * и партнёр не мог даже посмотреть свои.
   *
   * **Без коридора цена не принимается** — прямое требование
   * [ADR-0023](../../../../../docs/adr/0023-koridory-cen.md): иначе правило о коридорах
   * становится добровольным ровно для той стороны, ради ограничения которой заведено.
   * Отказ приходит с названием направления и с тем, что делать: коридор задаёт площадка,
   * и без этой строки отказ читается как ошибка самого партнёра.
   *
   * Строка не редактируется, добавляется новая: история цен остаётся целой, а вызов,
   * тарифицированный вчера, не переоценивается сегодняшней ценой. Действует **с этого
   * момента** — время начала действия у партнёра не принимается, см. `partnerOwnRateSchema`.
   */
  @Cabinets('partner')
  @Post('partner/rates')
  async setRate(
    @CurrentUser() actor: Principal,
    @Body(zodBody(partnerOwnRateSchema)) body: z.infer<typeof partnerOwnRateSchema>,
  ): Promise<{ rate: RateView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    // Закрытый партнёр не меняет ничего: состояние необратимо, и запись цены оставила бы
    // в журнале действие участника, которого больше нет.
    if (partner.status === 'closed') {
      throw permissionDenied('Партнёр закрыт: изменения недоступны');
    }

    const row = await this.tariffs.addPartnerRate(
      {
        partnerId: partner.id,
        operatorId: parseId(body.operatorId, 'operator'),
        terminationKind: body.terminationKind,
        region: body.region ?? null,
        pricePerMinute: body.pricePerMinute,
        billingIncrementSeconds: body.billingIncrementSeconds,
        minimumDurationSeconds: body.minimumDurationSeconds,
        connectionFee: body.connectionFee ?? Money.ZERO,
        rounding: body.rounding,
        effectiveFrom: new Date(),
      },
      actor.userId,
      actor.role,
    );

    return { rate: toRateView(row) };
  }
}

function toPricedDirection(row: RateWithBand, names: Map<string, string>): PricedDirectionView {
  const { rate, band } = row;
  return {
    id: rate.id,
    operator_id: rate.operatorId,
    operator_name: names.get(rate.operatorId) ?? null,
    region: rate.region,
    termination_kind: rate.terminationKind,
    price_per_minute: Money.format(rate.pricePerMinute),
    billing_increment_seconds: rate.billingIncrementSeconds,
    minimum_duration_seconds: rate.minimumDurationSeconds,
    connection_fee: Money.format(rate.connectionFee),
    rounding: rate.rounding,
    effective_from: rate.effectiveFrom.toISOString(),
    reference_cost: Money.format(row.referenceCost),
    band:
      band === undefined
        ? null
        : { min_price: Money.format(band.minPrice), max_price: Money.format(band.maxPrice) },
    within_band: row.withinBand,
  };
}
