/**
 * Свои тарифы и цены так, как их видит **сам партнёр**.
 *
 * До этого обработчика партнёр не знал, по какой цене продаёт: цены заводит
 * администратор, и единственный способ их прочитать начинался с `partnerId` в адресе.
 * Партнёр, не знающий своей цены, не может ни спорить о начислении, ни понять,
 * почему через него не идут вызовы.
 *
 * Цены живут в **тарифах** ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)):
 * тариф выбирается у шлюза и меняется у SIM, и что есть в тарифе SIM, туда она и звонит.
 *
 * Коридор отдаётся **рядом с ценой**, а не отдельным списком: без него число на экране
 * не говорит ничего о том, куда можно двигаться, а разговор о цене — это разговор
 * о рамках ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  Money,
  parseId,
  permissionDenied,
  REFERENCE_CALL_SECONDS,
  type Id,
  type Rounding,
  type TerminationKind,
} from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { PartnerRow } from '../billing/billing.repository.js';
import type { Principal } from '../identity/identity.service.js';
import { CatalogService } from './catalog.service.js';
import { createTariffSchema, partnerOwnRateSchema, updateTariffSchema } from './schemas.js';
import { TariffService, type RateWithBand } from './tariff.service.js';
import { toRateView, toTariffView, type RateView, type TariffView } from './views.js';

/**
 * Цена партнёра по одному направлению одного тарифа.
 *
 * Направление — это оператор, регион **и способ терминации**
 * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)):
 * у партнёра с SIM и транком по одному оператору две разные цены, и сводить их
 * в одну строку было бы неправдой. Оператора нет — цена на все операторы (ADR-0056).
 *
 * `reference_cost` — стоимость эталонного вызова по этому тарифу. Именно она
 * сравнивается с коридором: тариф это пять чисел, и коридор, ограничивающий одну
 * лишь цену за минуту, обходится платой за соединение.
 */
interface PricedDirectionView {
  readonly id: string;
  readonly tariff_id: string | null;
  readonly operator_id: string | null;
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
  /** Рамки цены; у цены на все операторы — пересечение коридоров всех операторов. */
  readonly band: { min_price: string; max_price: string } | null;
  /** Уложилась ли цена в коридор. Коридора нет — уложилась по определению. */
  readonly within_band: boolean;
}

/**
 * Оператор, на которого можно назначить цену, — и общий коридор по нему, если площадка
 * его задала. Коридора нет — цена любая (ADR-0056): коридор — рамка, а не пропуск.
 */
interface OperatorChoiceView {
  readonly operator_id: string;
  readonly operator_name: string;
  readonly min_price: string | null;
  readonly max_price: string | null;
}

@Controller()
export class PartnerPricesController {
  constructor(
    private readonly tariffs: TariffService,
    private readonly catalog: CatalogService,
    private readonly billing: BillingService,
  ) {}

  /**
   * По какой цене я продаю и в каких рамках — по всем тарифам.
   *
   * Вместе с ценами отдаются операторы, по которым цены нет ни в одном тарифе: кандидат
   * без действующей цены по направлению в перебор не попадает **вообще** (ADR-0040),
   * то есть такой оператор — ёмкость, которая никогда не получит ни одного вызова.
   * Есть цена на все операторы — таких нет.
   */
  @Cabinets('partner')
  @Get('partner/rates')
  async rates(@CurrentUser() actor: Principal): Promise<{
    reference_call_seconds: number;
    bands_enabled: boolean;
    tariffs: TariffView[];
    rates: PricedDirectionView[];
    operators_without_price: { operator_id: string; operator_name: string }[];
    operators: OperatorChoiceView[];
  }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const at = new Date();
    const [tariffs, rows, verified, bands, bandsEnabled] = await Promise.all([
      this.tariffs.listTariffs(partner.id),
      this.tariffs.ratesWithBands(at, partner.id),
      this.catalog.verifiedOperators(),
      this.tariffs.generalBands(at),
      this.tariffs.bandsEnabled(),
    ]);

    // Имена — только для тех операторов, у кого цена есть: справочник наполнен планом
    // нумерации и содержит сотни записей, а брать его целиком ради десятка строк дорого.
    const operatorIds = rows
      .map((row) => row.rate.operatorId)
      .filter((id): id is Id<'operator'> => id !== null);
    const names = await this.catalog.operatorNamesOf(operatorIds);
    const priced = new Set<string>(operatorIds);
    const coversAll = rows.some((row) => row.rate.operatorId === null);

    return {
      // Длительность эталонного вызова отдаётся вместе с ценами: без неё непонятно,
      // что за число стоит рядом с коридором.
      reference_call_seconds: REFERENCE_CALL_SECONDS,
      bands_enabled: bandsEnabled,
      tariffs: tariffs.map(toTariffView),
      rates: rows.map((row) => toPricedDirection(row, names)),
      operators_without_price: coversAll
        ? []
        : verified
            .filter((operator) => !priced.has(operator.id))
            .map((operator) => ({ operator_id: operator.id, operator_name: operator.name })),
      operators: verified.map((operator) => {
        const band = bandsEnabled ? bands.get(operator.id) : undefined;
        return {
          operator_id: operator.id,
          operator_name: operator.name,
          min_price: band === undefined ? null : Money.format(band.minPrice),
          max_price: band === undefined ? null : Money.format(band.maxPrice),
        };
      }),
    };
  }

  /**
   * Назначить цену по направлению в своём тарифе.
   *
   * Строка не редактируется, добавляется новая: история цен остаётся целой, а вызов,
   * тарифицированный вчера, не переоценивается сегодняшней ценой. Действует **с этого
   * момента** на все SIM с этим тарифом — время начала действия у партнёра
   * не принимается, см. `partnerOwnRateSchema`. Тариф не назван — тариф по умолчанию.
   */
  @Cabinets('partner')
  @Post('partner/rates')
  async setRate(
    @CurrentUser() actor: Principal,
    @Body(zodBody(partnerOwnRateSchema)) body: z.infer<typeof partnerOwnRateSchema>,
  ): Promise<{ rate: RateView }> {
    const partner = await this.editablePartner(actor);

    const row = await this.tariffs.addPartnerRate(
      {
        partnerId: partner.id,
        tariffId:
          body.tariffId === undefined
            ? (await this.tariffs.defaultTariff(partner.id)).id
            : parseId(body.tariffId, 'partnerTariff'),
        operatorId: body.operatorId == null ? null : parseId(body.operatorId, 'operator'),
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

  /** Новый тариф — пустой: цены в него добавляются так же, как в тариф по умолчанию. */
  @Cabinets('partner')
  @Post('partner/tariffs')
  async createTariff(
    @CurrentUser() actor: Principal,
    @Body(zodBody(createTariffSchema)) body: z.infer<typeof createTariffSchema>,
  ): Promise<{ tariff: TariffView }> {
    const partner = await this.editablePartner(actor);
    const row = await this.tariffs.createTariff(partner.id, body.name, actor);
    return { tariff: toTariffView(row) };
  }

  @Cabinets('partner')
  @Patch('partner/tariffs/:id')
  async updateTariff(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(updateTariffSchema)) body: z.infer<typeof updateTariffSchema>,
  ): Promise<{ tariff: TariffView }> {
    const partner = await this.editablePartner(actor);
    const row = await this.tariffs.updateTariff(
      partner.id,
      parseId(id, 'partnerTariff'),
      body,
      actor,
    );
    return { tariff: toTariffView(row) };
  }

  @Cabinets('partner')
  @Delete('partner/tariffs/:id')
  @HttpCode(204)
  async deleteTariff(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    const partner = await this.editablePartner(actor);
    await this.tariffs.deleteTariff(partner.id, parseId(id, 'partnerTariff'), actor);
  }

  /**
   * Карточка партнёра, которую можно менять. Закрытый партнёр не меняет ничего:
   * состояние необратимо, и запись оставила бы в журнале действие участника, которого
   * больше нет.
   */
  private async editablePartner(actor: Principal): Promise<PartnerRow> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    if (partner.status === 'closed') {
      throw permissionDenied('Партнёр закрыт: изменения недоступны');
    }
    return partner;
  }
}

function toPricedDirection(row: RateWithBand, names: Map<string, string>): PricedDirectionView {
  const { rate, limits } = row;
  return {
    id: rate.id,
    tariff_id: rate.tariffId,
    operator_id: rate.operatorId,
    operator_name: rate.operatorId === null ? null : (names.get(rate.operatorId) ?? null),
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
      limits === undefined
        ? null
        : { min_price: Money.format(limits.minPrice), max_price: Money.format(limits.maxPrice) },
    within_band: row.withinBand,
  };
}
