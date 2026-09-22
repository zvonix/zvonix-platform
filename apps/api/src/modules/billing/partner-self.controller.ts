/**
 * Деньги и состояние так, как их видит **сам партнёр**.
 *
 * Зеркало клиентского контура ([client-self.controller.ts](client-self.controller.ts)):
 * идентификатор партнёра здесь не принимается нигде, он выводится из сессии.
 * Административные обработчики `/partners/:id/*` открывать партнёру было нельзя —
 * туда пришлось бы пускать с чужим идентификатором в адресе и сверять владение
 * на каждом входе.
 *
 * До этих обработчиков партнёр не мог узнать о себе ничего: ни в каком он состоянии,
 * ни сколько заработал. Состояние здесь — не украшение: партнёр работает только
 * в `verified`, и `pending` объясняет, почему через его железо не идёт ни один вызов.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { Money, type PartnerStatus } from '@zvonix/shared';
import { Roles } from '../../http/auth.guard.js';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';
import { CurrentUser } from '../../http/request-context.js';
import type { Principal } from '../identity/identity.service.js';
import { BillingService } from './billing.service.js';
import { toEntryView, type EntryView } from './views.js';

/** Потолок страницы движения по счёту — тот же, что и у клиента. */
const ENTRIES_PAGE_MAX = 200;

/**
 * Партнёр о себе.
 *
 * Псевдоним рядом с именем намеренно: под ним партнёра видит клиент, и в разговоре
 * с площадкой речь идёт именно о нём.
 */
interface SelfView {
  readonly id: string;
  readonly name: string;
  /** Как партнёра называет клиент (ADR-0014). Пусто быть не должно, но проверять нечем. */
  readonly display_name: string | null;
  readonly status: PartnerStatus;
  /** Объявленное намерение слушать записи своих вызовов (ADR-0036). */
  readonly listens_to_recordings: boolean;
  readonly created_at: string;
}

@Controller()
export class PartnerSelfController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Кто я и сколько заработано.
   *
   * Один остаток без «доступно»: резервы и разрешённый минус — устройство клиентского
   * счёта, партнёру платят, а не он платит. Остаток здесь — то, что причитается
   * к выплате; сами выплаты появятся на шестом этапе и уменьшат его проводкой.
   */
  @Roles('partner')
  @Get('partner/account')
  async account(
    @CurrentUser() actor: Principal,
  ): Promise<{ partner: SelfView; funds: { balance: string } }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const [alias, account] = await Promise.all([
      this.billing.partnerAliasOf(partner.id),
      this.billing.accountOf('partner', partner.id),
    ]);

    return {
      partner: {
        id: partner.id,
        name: partner.name,
        display_name: alias ?? null,
        status: partner.status,
        listens_to_recordings: partner.listensToRecordings,
        created_at: partner.createdAt.toISOString(),
      },
      funds: { balance: Money.format(account.balance) },
    };
  }

  /**
   * Движение денег по своему счёту.
   *
   * Тот же вид, что у администратора и у клиента: у каждой проводки видно, **за что**
   * она. Спор о начислении иначе не разобрать, а разбор здесь и есть основной сценарий —
   * партнёр сверяет наши числа со счётом своего оператора.
   */
  @Roles('partner')
  @Get('partner/entries')
  async entries(
    @CurrentUser() actor: Principal,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ entries: EntryView[]; balance: string; total: number }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const account = await this.billing.accountOf('partner', partner.id);
    const found = await this.billing.listEntries(
      account.id,
      boundedLimit(limit, ENTRIES_PAGE_MAX),
      boundedOffset(offset),
    );

    return {
      balance: Money.format(account.balance),
      total: found.total,
      entries: found.rows.map(toEntryView),
    };
  }
}
