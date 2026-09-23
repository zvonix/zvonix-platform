/**
 * Деньги так, как их видит **сам клиент**.
 *
 * Отдельный контур, а не роль `client` на административных обработчиках: там путь
 * начинается с идентификатора клиента в адресе, и открыть их клиенту значило бы
 * разрешить подставить чужой. Здесь клиент выводится из сессии и подставить нечего.
 *
 * До появления этих обработчиков клиент не мог узнать о себе вообще ничего: ни остатка,
 * ни каналов, ни вызовов. Обработчики его собственных настроек — порядок партнёров
 * и разрешённые операторы — существовали, но требовали идентификатор канала, а взять
 * его было неоткуда.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { Money, type ClientStatus } from '@zvonix/shared';
import { Cabinets } from '../../http/auth.guard.js';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';
import { CurrentUser } from '../../http/request-context.js';
import type { Principal } from '../identity/identity.service.js';
import { BillingService } from './billing.service.js';
import { ReservationService } from './reservation.service.js';
import { toEntryView, toFundsView, type EntryView, type FundsView } from './views.js';

/** Потолок страницы движения по счёту: это таблица для человека, а не выгрузка. */
const ENTRIES_PAGE_MAX = 200;

/**
 * Клиент о себе.
 *
 * Ни владельца, ни служебных отметок: он и так знает, кто он. Состояние здесь есть
 * намеренно — «приостановлен» объясняет, почему не идут вызовы, и без него человек
 * ищет причину в своей АТС.
 */
interface SelfView {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly created_at: string;
}

@Controller()
export class ClientSelfController {
  constructor(
    private readonly billing: BillingService,
    private readonly reservations: ReservationService,
  ) {}

  /**
   * Кто я и сколько могу потратить.
   *
   * Остаток и «доступно» отдаются вместе: по отдельности они порождают ровно тот
   * вопрос, ради которого сюда и приходят, — «деньги же есть, почему не звонит».
   *
   * Заодно освобождает просроченные резервы — тем же способом, что и административный
   * обработчик: зависший из-за потерянного CDR резерв иначе тихо съедает доступное.
   */
  @Cabinets('client')
  @Get('client/account')
  async account(@CurrentUser() actor: Principal): Promise<{ client: SelfView; funds: FundsView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    await this.reservations.releaseExpired();

    return {
      client: {
        id: client.id,
        name: client.name,
        status: client.status,
        created_at: client.createdAt.toISOString(),
      },
      funds: toFundsView(await this.reservations.available(client.id)),
    };
  }

  /**
   * Движение денег по своему счёту.
   *
   * Тот же вид, что и у администратора: у каждой проводки видно, **что произошло**,
   * а не только сумма. Спор о списании иначе не разобрать, а разбор здесь и есть
   * основной сценарий.
   */
  @Cabinets('client')
  @Get('client/entries')
  async entries(
    @CurrentUser() actor: Principal,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ entries: EntryView[]; balance: string; total: number }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const account = await this.billing.accountOf('client', client.id);
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
