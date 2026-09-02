/**
 * HTTP-контракт денег.
 *
 * Суммы отдаются строкой в основных единицах: JSON-число потеряло бы точность
 * на больших суммах, а копейки — на любых.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Money, parseId, type MoneyAmount } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';
import { ReservationService } from './reservation.service.js';
import { createClientSchema, createPartnerSchema, depositSchema } from './schemas.js';

interface ClientView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly overdraft_limit: string;
  readonly balance: string;
}

interface EntryView {
  readonly seq: string;
  readonly transaction_id: string;
  readonly amount: string;
  readonly created_at: string;
}

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly repository: BillingRepository,
    private readonly reservations: ReservationService,
  ) {}

  @Roles('admin')
  @Post('clients')
  async createClient(
    @Body(zodBody(createClientSchema)) body: z.infer<typeof createClientSchema>,
  ): Promise<{ client: ClientView }> {
    const client = await this.repository.createClient({
      ownerUserId: parseId(body.ownerUserId, 'user'),
      name: body.name,
      status: 'pending',
      overdraftLimit: body.overdraftLimit ?? Money.ZERO,
    });
    // Счёт заводится сразу: клиент без счёта — участник, которому некуда начислить.
    await this.billing.accountOf('client', client.id);

    return { client: toClientView(client, Money.ZERO) };
  }

  @Roles('admin', 'support')
  @Get('clients')
  async listClients(): Promise<{ clients: ClientView[] }> {
    const rows = await this.repository.listClients();
    return {
      clients: await Promise.all(
        rows.map(async (row) => toClientView(row, await this.billing.balanceOf('client', row.id))),
      ),
    };
  }

  /**
   * Ручное пополнение баланса клиента.
   *
   * Способ поступления денег на модель не влияет: это такая же проводка, как платёж
   * через эквайринг. Повтор с тем же ключом идемпотентности денег не добавит.
   */
  @Roles('admin')
  @Post('clients/:id/deposit')
  @HttpCode(200)
  async deposit(
    @Param('id') id: string,
    @Body(zodBody(depositSchema)) body: z.infer<typeof depositSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ transaction_id: string; already_posted: boolean; balance: string }> {
    const clientId = parseId(id, 'client');
    const posted = await this.billing.depositToClient({
      clientId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      description: body.description,
      actorUserId: actor.userId,
    });

    return {
      transaction_id: posted.transaction.id,
      already_posted: posted.alreadyPosted,
      balance: Money.format(await this.billing.balanceOf('client', clientId)),
    };
  }

  @Roles('admin', 'support')
  @Get('clients/:id/entries')
  async entries(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<{ entries: EntryView[]; balance: string }> {
    const clientId = parseId(id, 'client');
    const account = await this.billing.accountOf('client', clientId);
    const rows = await this.billing.listEntries(account.id, boundedLimit(limit));

    return {
      balance: Money.format(account.balance),
      entries: rows.map((row) => ({
        seq: row.seq.toString(),
        transaction_id: row.transactionId,
        amount: Money.format(row.amount),
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Сколько клиент может потратить прямо сейчас.
   *
   * Остаток — не ответ на этот вопрос: часть средств придержана под идущие вызовы.
   * Разбор «почему клиент не может звонить, деньги же есть» начинается именно отсюда.
   *
   * Заодно освобождает просроченные резервы. Пока нет фоновой задачи, это единственное
   * место, где зависший из-за потерянного CDR резерв размораживается: иначе клиент
   * перестаёт звонить, а причина не видна ниоткуда.
   */
  @Roles('admin', 'support')
  @Get('clients/:id/funds')
  async funds(@Param('id') id: string): Promise<{
    balance: string;
    overdraft_limit: string;
    held: string;
    available: string;
  }> {
    await this.reservations.releaseExpired();
    const funds = await this.reservations.available(parseId(id, 'client'));

    return {
      balance: Money.format(funds.balance),
      overdraft_limit: Money.format(funds.overdraftLimit),
      held: Money.format(funds.held),
      available: Money.format(funds.available),
    };
  }

  @Roles('admin')
  @Post('partners')
  async createPartner(
    @Body(zodBody(createPartnerSchema)) body: z.infer<typeof createPartnerSchema>,
  ): Promise<{ partner: { id: string; display_name: string; status: string } }> {
    const partner = await this.repository.createPartner({
      ownerUserId: parseId(body.ownerUserId, 'user'),
      name: body.name,
      status: 'pending',
    });
    await this.repository.setPartnerAlias(partner.id, body.displayName);
    await this.billing.accountOf('partner', partner.id);

    // Настоящее имя не возвращается даже администратору через этот ответ:
    // так его нельзя случайно показать в общем интерфейсе (ADR-0014).
    return { partner: { id: partner.id, display_name: body.displayName, status: partner.status } };
  }

  /**
   * Сверка остатков с журналом.
   *
   * Пустой список — норма. Непустой означает, что какое-то движение прошло мимо
   * журнала, и это инцидент с разбором, а не повод подогнать остаток.
   */
  @Roles('admin')
  @Get('billing/reconcile')
  async reconcile(): Promise<{
    balanced: boolean;
    discrepancies: { account_id: string; stored: string; computed: string }[];
  }> {
    const found = await this.billing.reconcile();
    return {
      balanced: found.length === 0,
      discrepancies: found.map((item) => ({
        account_id: item.accountId,
        stored: Money.format(item.stored as MoneyAmount),
        computed: Money.format(item.computed as MoneyAmount),
      })),
    };
  }
}

/** Верхняя граница выборки: без неё запрос без параметра выгружает весь журнал. */
function boundedLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 1000);
}

function toClientView(
  row: { id: string; name: string; status: string; overdraftLimit: MoneyAmount },
  balance: MoneyAmount,
): ClientView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    overdraft_limit: Money.format(row.overdraftLimit),
    balance: Money.format(balance),
  };
}
