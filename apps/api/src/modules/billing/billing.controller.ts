/**
 * HTTP-контракт денег.
 *
 * Суммы отдаются строкой в основных единицах: JSON-число потеряло бы точность
 * на больших суммах, а копейки — на любых.
 */

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  isStaffRole,
  Money,
  notFound,
  parseId,
  type MoneyAmount,
  type PartnerStatus,
} from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import { IdentityService, type Principal } from '../identity/identity.service.js';
import {
  BillingRepository,
  type ClientWithBalance,
  type PartnerWithBalance,
} from './billing.repository.js';
import { BillingService } from './billing.service.js';
import { toEntryView, toFundsView, type EntryView, type FundsView } from './views.js';
import { ReservationService } from './reservation.service.js';
import {
  clientListQuerySchema,
  clientStatusSchema,
  createClientSchema,
  createPartnerSchema,
  depositSchema,
  overdraftSchema,
  partnerAliasSchema,
  partnerListQuerySchema,
  partnerStatusSchema,
  recordingsAccessSchema,
} from './schemas.js';

/** Потолок страницы движения по счёту: это таблица для человека, а не выгрузка. */
const ENTRIES_PAGE_MAX = 200;

interface ClientView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly overdraft_limit: string;
  readonly balance: string;
  readonly created_at: string;
}

/**
 * Партнёр в административном ответе.
 *
 * Настоящее имя здесь есть намеренно: клиентский контур ходит другим обработчиком
 * (`GET /partner-aliases`), и туда имя не попадает ни в каком виде
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 */
interface PartnerView {
  readonly id: string;
  readonly name: string;
  /** Пусто, если псевдоним почему-то не завёлся: такого партнёра надо увидеть, а не спрятать. */
  readonly display_name: string | null;
  readonly status: PartnerStatus;
  readonly listens_to_recordings: boolean;
  readonly balance: string;
  readonly created_at: string;
}

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly identity: IdentityService,
    private readonly repository: BillingRepository,
    private readonly reservations: ReservationService,
  ) {}

  @Roles('admin')
  @Post('clients')
  async createClient(
    @Body(zodBody(createClientSchema)) body: z.infer<typeof createClientSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ client: ClientView }> {
    const owner = await this.identity.requireParticipant(parseId(body.ownerUserId, 'user'));
    const client = await this.billing.createClient(
      { ownerUserId: owner.id, name: body.name, overdraftLimit: body.overdraftLimit ?? Money.ZERO },
      actor,
    );

    return { client: toClientView({ ...client, balance: Money.ZERO }) };
  }

  /**
   * Смена состояния клиента.
   *
   * Единственный путь к `active`, а без него клиент бесполезен: маршрутизация требует
   * `active` и от канала, и от самого клиента. До появления обработчика такого пути
   * не было вовсе — ровно как у партнёра.
   */
  @Roles('admin')
  @Patch('clients/:id/status')
  async setClientStatus(
    @Param('id') id: string,
    @Body(zodBody(clientStatusSchema)) body: z.infer<typeof clientStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ client: { id: string; status: string } }> {
    const client = await this.billing.changeClientStatus(parseId(id, 'client'), body.status, {
      userId: parseId(actor.userId, 'user'),
      role: actor.role,
    });
    return { client: { id: client.id, status: client.status } };
  }

  /**
   * Смена разрешённого минуса.
   *
   * До появления обработчика эта величина задавалась только при заведении и потом
   * не менялась ничем: опечатка в разрядах означала кредит, который нечем отозвать.
   * Действие денежное — попадает в журнал вместе с прежним значением.
   */
  @Roles('admin')
  @Patch('clients/:id/overdraft')
  async setOverdraft(
    @Param('id') id: string,
    @Body(zodBody(overdraftSchema)) body: z.infer<typeof overdraftSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ client: { id: string; overdraft_limit: string } }> {
    const client = await this.billing.changeOverdraftLimit(
      parseId(id, 'client'),
      body.overdraftLimit,
      { userId: parseId(actor.userId, 'user'), role: actor.role },
    );
    return { client: { id: client.id, overdraft_limit: Money.format(client.overdraftLimit) } };
  }
  /**
   * Клиенты с остатками.
   *
   * Остаток приходит тем же запросом, что и сам список: раньше он спрашивался
   * отдельно на каждого клиента.
   */
  @Roles('admin', 'support')
  @Get('clients')
  async listClients(
    @Query(zodQuery(clientListQuerySchema)) query: z.infer<typeof clientListQuerySchema>,
  ): Promise<{ clients: ClientView[]; total: number }> {
    const found = await this.billing.listClients({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.name === undefined ? {} : { name: query.name }),
      limit: query.limit,
      offset: query.offset,
    });

    return { clients: found.rows.map(toClientView), total: found.total };
  }

  /** Карточка клиента: та же строка, что в списке. Нет такого — `404`. */
  @Roles('admin', 'support')
  @Get('clients/:id')
  async getClient(@Param('id') id: string): Promise<{ client: ClientView }> {
    return { client: toClientView(await this.billing.clientWithBalance(parseId(id, 'client'))) };
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

  /**
   * Ручное пополнение счёта партнёра — добавляет к тому, что ему причитается.
   *
   * Зеркало пополнения клиента: тот же ключ идемпотентности и те же правила, вид проводки
   * `correction`. Журнал — той же транзакцией.
   */
  @Roles('admin')
  @Post('partners/:id/deposit')
  @HttpCode(200)
  async depositPartner(
    @Param('id') id: string,
    @Body(zodBody(depositSchema)) body: z.infer<typeof depositSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ transaction_id: string; already_posted: boolean; balance: string }> {
    const partnerId = parseId(id, 'partner');
    const posted = await this.billing.depositToPartner({
      partnerId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      description: body.description,
      actorUserId: actor.userId,
    });

    return {
      transaction_id: posted.transaction.id,
      already_posted: posted.alreadyPosted,
      balance: Money.format(await this.billing.balanceOf('partner', partnerId)),
    };
  }

  /**
   * Выплата партнёру: перевод сделан вне системы, здесь он записывается, и «причитается»
   * уменьшается. Больше причитающегося выплатить нельзя — `409`.
   */
  @Roles('admin')
  @Post('partners/:id/payout')
  @HttpCode(200)
  async payoutPartner(
    @Param('id') id: string,
    @Body(zodBody(depositSchema)) body: z.infer<typeof depositSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ transaction_id: string; already_posted: boolean; balance: string }> {
    const partnerId = parseId(id, 'partner');
    const posted = await this.billing.payoutToPartner({
      partnerId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      description: body.description,
      actorUserId: actor.userId,
    });

    return {
      transaction_id: posted.transaction.id,
      already_posted: posted.alreadyPosted,
      balance: Money.format(await this.billing.balanceOf('partner', partnerId)),
    };
  }

  /** Ручное списание со счёта партнёра — исправление ошибочного начисления. */
  @Roles('admin')
  @Post('partners/:id/debit')
  @HttpCode(200)
  async debitPartner(
    @Param('id') id: string,
    @Body(zodBody(depositSchema)) body: z.infer<typeof depositSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ transaction_id: string; already_posted: boolean; balance: string }> {
    const partnerId = parseId(id, 'partner');
    const posted = await this.billing.debitPartner({
      partnerId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      description: body.description,
      actorUserId: actor.userId,
    });

    return {
      transaction_id: posted.transaction.id,
      already_posted: posted.alreadyPosted,
      balance: Money.format(await this.billing.balanceOf('partner', partnerId)),
    };
  }

  /** Ручное списание со счёта клиента — исправление ошибочного пополнения. */
  @Roles('admin')
  @Post('clients/:id/debit')
  @HttpCode(200)
  async debitClient(
    @Param('id') id: string,
    @Body(zodBody(depositSchema)) body: z.infer<typeof depositSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ transaction_id: string; already_posted: boolean; balance: string }> {
    const clientId = parseId(id, 'client');
    const posted = await this.billing.debitClient({
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

  /**
   * Движение денег по счёту клиента.
   *
   * Каждая проводка идёт вместе с тем, **что произошло**: вид операции и описание.
   * Столбец сумм без этого не отвечает ни на один вопрос разбора, а разбор здесь —
   * основной сценарий ([DESIGN.md](../../../../../docs/DESIGN.md)).
   */
  @Roles('admin', 'support')
  @Get('clients/:id/entries')
  async entries(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ entries: EntryView[]; balance: string; total: number }> {
    const clientId = parseId(id, 'client');
    const account = await this.billing.accountOf('client', clientId);
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
  async funds(@Param('id') id: string): Promise<FundsView> {
    await this.reservations.releaseExpired();
    return toFundsView(await this.reservations.available(parseId(id, 'client')));
  }

  @Roles('admin')
  @Post('partners')
  async createPartner(
    @Body(zodBody(createPartnerSchema)) body: z.infer<typeof createPartnerSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ partner: { id: string; display_name: string; status: string } }> {
    const owner = await this.identity.requireParticipant(parseId(body.ownerUserId, 'user'));
    const partner = await this.billing.createPartner(
      { ownerUserId: owner.id, name: body.name, displayName: body.displayName },
      actor,
    );

    // Настоящее имя не возвращается даже администратору через этот ответ:
    // так его нельзя случайно показать в общем интерфейсе (ADR-0014).
    return { partner: { id: partner.id, display_name: body.displayName, status: partner.status } };
  }

  /**
   * Партнёры — административный список.
   *
   * Здесь настоящее имя есть, и это не спор с
   * [ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md): запрет
   * закрывает **клиентский** контур, а не административный. Клиентский путь один
   * и рядом — `GET /partner-aliases`, и там имени нет.
   *
   * До этого обработчика заведённого партнёра нельзя было ни найти, ни перечислить:
   * `POST /partners` отдавал идентификатор один раз, и всё.
   */
  @Roles('admin', 'support')
  @Get('partners')
  async listPartners(
    @Query(zodQuery(partnerListQuerySchema)) query: z.infer<typeof partnerListQuerySchema>,
  ): Promise<{ partners: PartnerView[]; total: number }> {
    const found = await this.billing.listPartners({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.name === undefined ? {} : { name: query.name }),
      limit: query.limit,
      offset: query.offset,
    });

    return { partners: found.rows.map(toPartnerView), total: found.total };
  }

  /** Карточка партнёра: та же строка, что в списке, с настоящим именем. Нет такого — `404`. */
  @Roles('admin', 'support')
  @Get('partners/:id')
  async getPartner(@Param('id') id: string): Promise<{ partner: PartnerView }> {
    return {
      partner: toPartnerView(await this.billing.partnerWithBalance(parseId(id, 'partner'))),
    };
  }

  /**
   * Смена состояния партнёра.
   *
   * Единственный путь к `verified`, а без него партнёр бесполезен: и регистрация
   * его шлюза, и отбор SIM под вызов требуют именно этого состояния. До появления
   * обработчика такого пути не было вовсе.
   */
  @Roles('admin')
  @Patch('partners/:id/status')
  async setPartnerStatus(
    @Param('id') id: string,
    @Body(zodBody(partnerStatusSchema)) body: z.infer<typeof partnerStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ partner: { id: string; status: string } }> {
    const partner = await this.billing.changePartnerStatus(parseId(id, 'partner'), body.status, {
      userId: parseId(actor.userId, 'user'),
      role: actor.role,
    });
    return { partner: { id: partner.id, status: partner.status } };
  }

  /**
   * Движение денег по счёту партнёра.
   *
   * Тот же разбор, что и у клиента, только с другой стороны: партнёру начисляют
   * долю за вызов и списывают при выплате. Вопрос «за что начислено» без этого
   * списка отвечать нечем.
   */
  @Roles('admin', 'support')
  @Get('partners/:id/entries')
  async partnerEntries(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ entries: EntryView[]; balance: string; total: number }> {
    const partnerId = parseId(id, 'partner');
    if ((await this.repository.findPartner(partnerId)) === undefined) {
      throw notFound('Партнёр не найден');
    }

    const account = await this.billing.accountOf('partner', partnerId);
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

  /**
   * Переименование псевдонима партнёра.
   *
   * Псевдоним — единственное, что клиент вообще знает о партнёре
   * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)), и до появления
   * обработчика он задавался только при заведении: опечатка оставалась навсегда
   * и на глазах у всех клиентов.
   *
   * Занятое имя — `409` с названной причиной: псевдоним уникален на всю площадку,
   * иначе один поставщик выглядел бы у клиента несколькими разными.
   */
  @Roles('admin')
  @Put('partners/:id/alias')
  async renamePartnerAlias(
    @Param('id') id: string,
    @Body(zodBody(partnerAliasSchema)) body: z.infer<typeof partnerAliasSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ partner: { id: string; display_name: string } }> {
    const partnerId = parseId(id, 'partner');
    const displayName = await this.billing.renamePartnerAlias(partnerId, body.displayName, {
      userId: parseId(actor.userId, 'user'),
      role: actor.role,
    });
    return { partner: { id: partnerId, display_name: displayName } };
  }

  /**
   * Партнёры, из которых клиент выбирает, — под псевдонимами.
   *
   * Список, из которого строится порядок партнёров в канале. Ни идентификатора партнёра,
   * ни настоящего имени: клиент знает о партнёре ровно псевдоним, и возврат чего-то ещё
   * в клиентский контур ADR-0014 считает дефектом уровня инварианта.
   */
  @Roles('admin', 'support')
  @Cabinets('client')
  @Get('partner-aliases')
  async listPartnerAliases(@CurrentUser() actor: Principal): Promise<{
    partners: { alias_id: string; display_name: string; listens_to_recordings: boolean }[];
  }> {
    const rows = await this.repository.listOfferedAliases(
      isStaffRole(actor.role) ? undefined : actor.userId,
    );
    return {
      partners: rows.map((row) => ({
        alias_id: row.id,
        display_name: row.displayName,
        // Объявленное партнёром намерение слушать записи своих вызовов
        // ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
        // Анонимность не страдает: это свойство псевдонима, а не личность.
        listens_to_recordings: row.listensToRecordings,
      })),
    };
  }

  /**
   * Партнёр объявляет, слушает ли он записи своих вызовов (ADR-0036).
   *
   * Меняет сам партнёр либо администратор; владение проверяет служба. Признак сразу
   * виден клиентам в списке псевдонимов — они по нему и выбирают.
   */
  @Roles('admin')
  @Cabinets('partner')
  @Put('partners/:id/recordings-access')
  async setRecordingsAccess(
    @Param('id') id: string,
    @Body(zodBody(recordingsAccessSchema)) body: z.infer<typeof recordingsAccessSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ partner: { id: string; listens_to_recordings: boolean } }> {
    const partner = await this.billing.setRecordingsAccess(parseId(id, 'partner'), body.listens, {
      userId: parseId(actor.userId, 'user'),
      role: actor.role,
    });
    return { partner: { id: partner.id, listens_to_recordings: partner.listensToRecordings } };
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

function toClientView(row: ClientWithBalance): ClientView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    overdraft_limit: Money.format(row.overdraftLimit),
    balance: Money.format(row.balance),
    created_at: row.createdAt.toISOString(),
  };
}

function toPartnerView(row: PartnerWithBalance): PartnerView {
  return {
    id: row.id,
    name: row.name,
    // Псевдоним заводится вместе с партнёром, но список обязан пережить его отсутствие:
    // партнёр без псевдонима — это как раз тот, кого администратору нужно увидеть.
    display_name: row.displayName,
    status: row.status,
    listens_to_recordings: row.listensToRecordings,
    balance: Money.format(row.balance),
    created_at: row.createdAt.toISOString(),
  };
}

/** Проводка в виде ответа. Одна на оба счёта — клиента и партнёра. */
