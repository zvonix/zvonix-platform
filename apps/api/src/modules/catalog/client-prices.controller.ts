/**
 * Что почём для клиента.
 *
 * До этого обработчика клиент расставлял приоритеты **вслепую** — по псевдониму, ничего
 * не зная о стоимости. Приоритет без цены это выбор наугад, и просить его у человека,
 * не показав чисел, значит просить не глядя
 * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
 *
 * Отдаётся **своя цена клиента**, а не тариф партнёра: чужая экономика клиенту
 * не адресована, а собственные деньги — его дело.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { Money, parseId, type TerminationKind } from '@zvonix/shared';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { TariffService } from './tariff.service.js';

/**
 * Предложение партнёра с диапазоном цен.
 *
 * Диапазон, а не одно число: цена задаётся по направлениям, и у одного предложения
 * их десятки. Одна величина здесь была бы либо неправдой, либо самой дорогой из всех.
 *
 * Цена — стоимость **эталонного вызова в 60 секунд** для клиента, то есть с учётом
 * платы за соединение и минимальной длительности. «Цена за минуту» без них сравнивала бы
 * тарифы, которые на деле стоят по-разному
 * ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md) считает коридор так же).
 */
interface OfferPriceView {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly min_price: string;
  readonly max_price: string;
  /** По скольким направлениям у предложения есть цена. */
  readonly directions: number;
}

/**
 * Из чего складывается цена по одному направлению.
 *
 * Шаг и минимум — структура тарифа, они одинаковы у обеих сторон. Суммы — клиентские,
 * с наценкой площадки внутри.
 *
 * `examples` здесь не украшение: два тарифа по 2 ₽ за минуту, один посекундный, другой
 * поминутный, на вызове в 60 секунд стоят одинаково, а на вызове в 20 секунд — втрое
 * по-разному. Сравнивать их одним числом нельзя, поэтому чисел несколько.
 */
interface TariffView {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly operator_id: string;
  readonly region: string | null;
  /** Шаг тарификации в секундах: единица — посекундно, шестьдесят — поминутно. */
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly price_per_minute: string;
  readonly connection_fee: string;
  readonly examples: readonly { seconds: number; amount: string }[];
}

@Controller()
export class ClientPricesController {
  constructor(
    private readonly tariffs: TariffService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Цены по предложениям — то, из чего клиент выбирает порядок.
   *
   * Только подтверждённые партнёры: предлагать порядок вокруг того, кто не может принять
   * вызов, значит звать строить его вокруг пустого места. Партнёр называется
   * **псевдонимом** и только им ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
   */
  @Cabinets('client')
  @Get('client/prices')
  async prices(
    @CurrentUser() actor: Principal,
    @Query('operatorId') operatorId?: string,
    @Query('seconds') seconds?: string,
  ): Promise<{ seconds: number; offers: OfferPriceView[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    // Свой партнёр в предложениях не показывается: звонить через себя нельзя (ADR-0052).
    const offered = await this.billing.listOfferedAliases(actor.userId);
    const duration = exampleDuration(seconds);

    const priced = await this.tariffs.offerPrices(
      client.id,
      offered.map((alias) => alias.partnerId),
      operatorId === undefined || operatorId === '' ? undefined : parseId(operatorId, 'operator'),
      duration,
      new Date(),
    );

    const byPartner = new Map(offered.map((alias) => [alias.partnerId, alias]));

    return {
      // Длительность возвращается вместе с ценами: без неё число на экране не значит
      // ничего, а сравнивать тарифы с разным шагом по одной величине нельзя.
      seconds: duration,
      offers: priced.flatMap((offer) => {
        const alias = byPartner.get(offer.partnerId);
        // Партнёр без псевдонима клиенту непредставим, а показать вместо него
        // идентификатор — прямое нарушение ADR-0014. Такого быть не должно: псевдоним
        // заводится вместе с партнёром, — но пропустить строку безопаснее, чем гадать.
        if (alias === undefined) return [];
        return [
          {
            alias_id: alias.id,
            display_name: alias.displayName,
            termination_kind: offer.terminationKind,
            min_price: Money.format(offer.minPrice),
            max_price: Money.format(offer.maxPrice),
            directions: offer.directions,
          },
        ];
      }),
    };
  }

  /**
   * Из чего складывается цена — по каждому направлению.
   *
   * Отдельно от `/client/prices`: тот отвечает «кто дешевле», этот — «почему столько».
   * Список длинный по существу дела, и сводить его в диапазон значило бы выбросить ровно
   * то, ради чего его открывают.
   */
  @Cabinets('client')
  @Get('client/tariffs')
  async directions(
    @CurrentUser() actor: Principal,
    @Query('operatorId') operatorId?: string,
  ): Promise<{ tariffs: TariffView[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    // Свой партнёр в предложениях не показывается: звонить через себя нельзя (ADR-0052).
    const offered = await this.billing.listOfferedAliases(actor.userId);

    const rows = await this.tariffs.clientTariffs(
      client.id,
      offered.map((alias) => alias.partnerId),
      operatorId === undefined || operatorId === '' ? undefined : parseId(operatorId, 'operator'),
      new Date(),
    );

    const byPartner = new Map(offered.map((alias) => [alias.partnerId, alias]));

    return {
      tariffs: rows.flatMap((row) => {
        const alias = byPartner.get(row.partnerId);
        if (alias === undefined) return [];
        return [
          {
            alias_id: alias.id,
            display_name: alias.displayName,
            termination_kind: row.terminationKind,
            operator_id: row.operatorId,
            region: row.region,
            billing_increment_seconds: row.billingIncrementSeconds,
            minimum_duration_seconds: row.minimumDurationSeconds,
            price_per_minute: Money.format(row.pricePerMinute),
            connection_fee: Money.format(row.connectionFee),
            examples: row.examples.map((example) => ({
              seconds: example.seconds,
              amount: Money.format(example.amount),
            })),
          },
        ];
      }),
    };
  }
}

/** Сколько секунд считать «вызовом», когда клиент сравнивает предложения. */
const DEFAULT_EXAMPLE_SECONDS = 60;
const MAX_EXAMPLE_SECONDS = 3600;

/**
 * Длительность из параметра адреса.
 *
 * Мусор и выход за границы дают умолчание, а не отказ: это сравнение цен, и опечатка
 * в адресе не должна возвращать ошибку вместо чисел.
 */
function exampleDuration(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_EXAMPLE_SECONDS;
  return Math.min(parsed, MAX_EXAMPLE_SECONDS);
}
