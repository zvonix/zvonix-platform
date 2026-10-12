/**
 * Цены «от» для сайта проекта ([ADR-0082](../../../../../docs/adr/0082-sayt-proekta.md)).
 *
 * Открыто без входа, поэтому отдаётся только агрегат: самая низкая цена для клиента по общей наценке.
 * Ни партнёр, ни их число, ни оператор в ответ не попадают
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)). Ответ держится в памяти пять минут:
 * сайт открывают чаще, чем меняются цены, а считать их — несколько запросов к базе.
 */

import { Controller, Get, Header } from '@nestjs/common';
import { Money } from '@zvonix/shared';
import { Public } from '../../http/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { MessagesService } from '../messaging/messages.service.js';

interface PricesView {
  /** Цена минуты звонка для клиента, ₽; `null` — цен нет, сайт пишет «по запросу». */
  readonly call_from: string | null;
  /** Цена одного сообщения MAX для клиента, ₽; `null` — как выше. */
  readonly message_from: string | null;
  readonly updated_at: string;
}

const TTL_MS = 5 * 60_000;

@Controller()
export class PublicPricesController {
  private cached: { at: number; view: PricesView } | undefined;
  private pending: Promise<PricesView> | undefined;

  constructor(
    private readonly tariffs: TariffService,
    private readonly billing: BillingService,
    private readonly messages: MessagesService,
  ) {}

  /** Сбрасывает кеш: нужен тестам и смене настроек наценки, чтобы не ждать пять минут. */
  resetCache(): void {
    this.cached = undefined;
  }

  @Public()
  @Get('public/prices')
  @Header('Cache-Control', 'public, max-age=300')
  async prices(): Promise<PricesView> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < TTL_MS) return this.cached.view;
    // Одновременные запросы ждут один расчёт: иначе первая волна посетителей считала бы цены каждый сам.
    this.pending ??= this.compute().finally(() => {
      this.pending = undefined;
    });
    const view = await this.pending;
    this.cached = { at: Date.now(), view };
    return view;
  }

  private async compute(): Promise<PricesView> {
    const at = new Date();
    const offered = await this.billing.listOfferedAliases();
    const partnerIds = [...new Set(offered.map((alias) => alias.partnerId))];
    const [call, message] = await Promise.all([
      this.tariffs.cheapestCallMinute(partnerIds, at),
      this.messages.cheapestPublic(),
    ]);
    return {
      call_from: call === undefined ? null : Money.format(call),
      message_from: message === undefined ? null : Money.format(message),
      updated_at: at.toISOString(),
    };
  }
}
