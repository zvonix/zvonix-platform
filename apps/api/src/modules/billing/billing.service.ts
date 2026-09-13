/**
 * Движение денег (ADR-0010).
 *
 * Единственное место во всём проекте, где меняется остаток на счёте. Прямая правка
 * остатка запрещена: баланс — это следствие проводок, а не самостоятельное значение.
 * Журнал, мимо которого прошло хоть одно движение, перестаёт быть доказательством
 * ровно тогда, когда нужен больше всего — в споре с клиентом или партнёром.
 */

import { Injectable } from '@nestjs/common';
import {
  conflict,
  Money,
  newId,
  notFound,
  validationFailed,
  type AccountKind,
  type ClientStatus,
  type MoneyAmount,
  type PartnerStatus,
  type TransactionKind,
  type UserRole,
} from '@zvonix/shared';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { MachineService } from '../machine/machine.service.js';
import {
  BillingRepository,
  type AccountId,
  type AccountRow,
  type ClientFilter,
  type ClientId,
  type ClientRow,
  type ClientWithBalance,
  type Executor,
  type PartnerAliasRow,
  type PartnerFilter,
  type PartnerId,
  type LedgerEntryRow,
  type LedgerEntryWithTransaction,
  type LedgerTransactionRow,
  type PartnerRow,
  type PartnerWithBalance,
  type UserId,
} from './billing.repository.js';

/** Половина движения: счёт и сумма со знаком. Плюс — приход, минус — расход. */
export interface PostingLine {
  readonly accountId: AccountId;
  readonly amount: MoneyAmount;
}

export interface TransactionDraft {
  readonly kind: TransactionKind;
  /**
   * Ключ идемпотентности: `deposit:<номер платежа>`, `charge:<идентификатор вызова>`.
   * Повторная попытка с тем же ключом не создаёт вторых проводок — узел может
   * прислать один и тот же CDR дважды, и это штатный режим.
   */
  readonly idempotencyKey: string;
  readonly description: string;
  readonly lines: readonly PostingLine[];
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly createdByUserId?: UserId;
  readonly occurredAt?: Date;

  /**
   * Что выполнить **в той же транзакции**, если проводка действительно создана.
   *
   * Нужно тому, чьё состояние обязано меняться вместе с деньгами и ровно один раз:
   * счётчик минут в лимитах ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md))
   * наследует отсюда идемпотентность по ключу — повторный CDR не начислит минуты дважды.
   *
   * На повторной доставке не вызывается: проводки нет, значит и делать нечего.
   */
  readonly alsoInTransaction?: (executor: Executor) => Promise<void>;

  /**
   * Запись в журнал действий — **той же транзакцией**
   * ([ADR-0034](../../../../../docs/adr/0034-zhurnal-deneg-odnoy-tranzakciey.md)).
   *
   * Не отдельным вызовом после проводки: спор о списании разбирается через месяцы
   * и разбирается по журналу, поэтому «не записалось» обязано означать «не произошло».
   * Здесь, а не у вызывающего, чтобы правило не приходилось помнить каждому новому
   * денежному действию.
   *
   * На повторной доставке не пишется: проводки нет, действия не было.
   *
   * Функция, а не готовое событие: идентификатор проводки появляется только внутри
   * транзакции, а без него строка журнала не связана с движением денег — то есть
   * бесполезна ровно в том разборе, ради которого пишется.
   */
  readonly audit?: (transaction: LedgerTransactionRow) => AuditEvent;
}

export interface PostedTransaction {
  readonly transaction: LedgerTransactionRow;
  readonly entries: readonly LedgerEntryRow[];
  /** `true`, если операция с таким ключом уже была и повторно не проводилась. */
  readonly alreadyPosted: boolean;
}

const DEFAULT_CURRENCY = 'RUB';

@Injectable()
export class BillingService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly audit: AuditService,
    // Ключи клиентского API (ADR-0044): закрытие клиента обязано закрывать и машинную
    // дверь. Тот же приём, что и у узла, выводимого из эксплуатации (`nodes.service`).
    private readonly machine: MachineService,
  ) {}

  /**
   * Проводит операцию: вставляет её, её проводки и правит остатки — одной транзакцией.
   *
   * Порядок внутри существенен и выбран не случайно:
   *   1. счета блокируются в порядке идентификаторов — иначе две встречные операции
   *      встают во взаимную блокировку;
   *   2. операция вставляется с ключом идемпотентности; если ключ занят, вся работа
   *      прекращается и возвращается прежний результат;
   *   3. правятся остатки и проверяется овердрафт — **после** правки, по фактическому
   *      значению из базы, а не по прочитанному заранее: между чтением и записью
   *      остаток мог измениться соседней операцией.
   */
  async post(draft: TransactionDraft): Promise<PostedTransaction> {
    this.validate(draft);

    // Быстрый выход без транзакции: повторную доставку одного и того же CDR
    // не нужно проводить через блокировку счетов.
    const seen = await this.repository.findTransactionByKey(draft.idempotencyKey);
    if (seen !== undefined) {
      return {
        transaction: seen,
        entries: await this.repository.listTransactionEntries(seen.id),
        alreadyPosted: true,
      };
    }

    const occurredAt = draft.occurredAt ?? new Date();

    return this.repository.db.transaction(async (tx) => {
      const ids = draft.lines.map((line) => line.accountId);
      const locked = await this.repository.lockAccounts(ids, tx);

      if (locked.length !== ids.length) {
        throw notFound('Счёт из проводки не существует');
      }
      this.assertSameCurrency(locked);

      const transaction = await this.repository.insertTransaction(
        {
          id: newId<'ledgerTransaction'>(),
          kind: draft.kind,
          idempotencyKey: draft.idempotencyKey,
          description: draft.description,
          referenceType: draft.referenceType ?? null,
          referenceId: draft.referenceId ?? null,
          createdByUserId: draft.createdByUserId ?? null,
          occurredAt,
        },
        tx,
      );

      if (transaction === undefined) {
        // Ключ заняли между быстрой проверкой и вставкой. Это не ошибка,
        // а ровно тот случай, ради которого ключ и существует.
        const existing = await this.repository.findTransactionByKey(draft.idempotencyKey, tx);
        if (existing === undefined) throw new Error('Операция не вставлена и не найдена');
        return {
          transaction: existing,
          entries: await this.repository.listTransactionEntries(existing.id),
          alreadyPosted: true,
        };
      }

      const entries = await this.repository.insertEntries(
        draft.lines.map((line) => ({
          id: newId<'ledgerEntry'>(),
          transactionId: transaction.id,
          accountId: line.accountId,
          amount: line.amount,
        })),
        tx,
      );

      const byId = new Map(locked.map((account) => [account.id, account]));
      for (const line of draft.lines) {
        const balance = await this.repository.adjustBalance(line.accountId, line.amount, tx);
        const account = byId.get(line.accountId);
        if (account !== undefined) await this.assertWithinOverdraft(account, balance);
      }

      if (draft.alsoInTransaction !== undefined) {
        await draft.alsoInTransaction(tx);
      }

      // Последним: журнал пишется тогда, когда действие состоялось целиком, и его
      // неудача откатывает всё вместе с ним (ADR-0034).
      if (draft.audit !== undefined) {
        await this.audit.record(draft.audit(transaction), tx);
      }

      return { transaction, entries, alreadyPosted: false };
    });
  }

  /**
   * Ручное пополнение баланса клиента администратором.
   *
   * Способ поступления денег на модель не влияет: ручное пополнение — такая же проводка,
   * как платёж через эквайринг. При ручных пополнениях журнал даже важнее — человек
   * ошибается и забывает, а строка «кто, кому, сколько, когда» останется.
   */
  async depositToClient(input: {
    clientId: ClientId;
    amount: MoneyAmount;
    idempotencyKey: string;
    description: string;
    actorUserId: UserId;
  }): Promise<PostedTransaction> {
    if (Money.compare(input.amount, Money.ZERO) <= 0) {
      throw validationFailed('Сумма пополнения должна быть больше нуля');
    }

    const client = await this.repository.findClient(input.clientId);
    if (client === undefined) throw notFound('Клиент не найден');

    const clientAccount = await this.accountOf('client', input.clientId);
    const settlement = await this.accountOf('settlement', null);

    return this.post({
      kind: 'deposit',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      referenceType: 'client',
      referenceId: input.clientId,
      createdByUserId: input.actorUserId,
      lines: [
        // Деньги входят в систему через шлюз платежей и оседают на счёте клиента.
        { accountId: settlement.id, amount: Money.negate(input.amount) },
        { accountId: clientAccount.id, amount: input.amount },
      ],
      audit: (transaction) => ({
        action: 'billing.client_deposited',
        entityType: 'client',
        entityId: input.clientId,
        actorUserId: input.actorUserId,
        after: {
          amount: Money.format(input.amount),
          transaction_id: transaction.id,
          idempotency_key: input.idempotencyKey,
        },
      }),
    });
  }

  /**
   * Партнёр объявляет, слушает ли он записи своих вызовов
   * ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
   *
   * Меняет только сам партнёр либо администратор: роль — первый рубеж, владение
   * проверяется здесь ([ADR-0018](../../../../../docs/adr/0018-autentifikaciya.md)).
   *
   * Признак виден клиенту в списке псевдонимов, и клиент, которому это не подходит,
   * такого партнёра в приоритеты канала не поставит. Партнёр это знает — цена решения
   * названа в ADR.
   */
  async setRecordingsAccess(
    partnerId: PartnerId,
    listens: boolean,
    actor: { userId: UserId; role: UserRole },
  ): Promise<PartnerRow> {
    const partner = await this.repository.findPartner(partnerId);
    if (partner === undefined) throw notFound('Партнёр не найден');

    if (actor.role === 'partner') {
      const own = await this.repository.findPartnerOwnedBy(actor.userId);
      // `not_found`, а не `permission_denied`: чужой партнёр не должен подтверждаться
      // разницей ответов.
      if (own === undefined || own.id !== partnerId) throw notFound('Партнёр не найден');
    }

    const updated = await this.repository.setListensToRecordings(partnerId, listens);
    if (updated === undefined) throw notFound('Партнёр не найден');

    await this.audit.record({
      action: 'partner.recordings_access_set',
      entityType: 'partner',
      entityId: partnerId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { listens_to_recordings: partner.listensToRecordings },
      after: { listens_to_recordings: updated.listensToRecordings },
    });

    return updated;
  }

  /**
   * Списание за состоявшийся вызов.
   *
   * Одна операция из трёх проводок: клиент платит, партнёр зарабатывает, платформа
   * удерживает наценку. Сумма трёх равна нулю — деньги не возникают и не исчезают.
   *
   * Ключ идемпотентности — `charge:<идентификатор вызова>`. Повторный CDR не создаёт
   * вторых проводок: узел может прислать его дважды, и это штатный режим, а не сбой
   * ([ADR-0010](../../../../../docs/adr/0010-model-billinga.md)).
   */
  async chargeCall(input: {
    callId: string;
    clientId: ClientId;
    partnerId: PartnerId;
    clientAmount: MoneyAmount;
    partnerAmount: MoneyAmount;
    commissionAmount: MoneyAmount;
    description: string;
    occurredAt: Date;
    /** Что сделать той же транзакцией: см. `TransactionDraft.alsoInTransaction`. */
    alsoInTransaction?: (executor: Executor) => Promise<void>;
  }): Promise<PostedTransaction> {
    const total = Money.add(input.partnerAmount, input.commissionAmount);
    if (Money.compare(total, input.clientAmount) !== 0) {
      // Сумма для клиента — не самостоятельное значение, а следствие двух других.
      // Расхождение означает ошибку расчёта, и проводить её нельзя ни при каких условиях.
      throw validationFailed('Доля партнёра и наценка не складываются в сумму для клиента', {
        details: {
          client: Money.format(input.clientAmount),
          partner: Money.format(input.partnerAmount),
          commission: Money.format(input.commissionAmount),
        },
      });
    }

    const clientAccount = await this.accountOf('client', input.clientId);
    const partnerAccount = await this.accountOf('partner', input.partnerId);
    const revenue = await this.accountOf('revenue', null);

    // Нулевые проводки не создаются: запись на ноль ничего не значит и только засоряет
    // журнал — база её и не примет.
    const lines: PostingLine[] = [
      { accountId: clientAccount.id, amount: Money.negate(input.clientAmount) },
    ];
    if (!Money.isZero(input.partnerAmount)) {
      lines.push({ accountId: partnerAccount.id, amount: input.partnerAmount });
    }
    if (!Money.isZero(input.commissionAmount)) {
      lines.push({ accountId: revenue.id, amount: input.commissionAmount });
    }

    return this.post({
      kind: 'charge',
      idempotencyKey: `charge:${input.callId}`,
      description: input.description,
      referenceType: 'call',
      referenceId: input.callId,
      // Тарификацию выполняет система, а не человек: приписывать её администратору
      // значило бы соврать журналу о том, кто действовал.
      occurredAt: input.occurredAt,
      lines,
      ...(input.alsoInTransaction === undefined
        ? {}
        : { alsoInTransaction: input.alsoInTransaction }),
    });
  }

  /** Счёт участника или системный. Заводится при первом обращении. */
  async accountOf(kind: AccountKind, ownerId: string | null): Promise<AccountRow> {
    return this.repository.ensureAccount(kind, ownerId, DEFAULT_CURRENCY);
  }

  async balanceOf(kind: AccountKind, ownerId: string | null): Promise<MoneyAmount> {
    const account = await this.repository.findAccount(kind, ownerId, DEFAULT_CURRENCY);
    return account?.balance ?? Money.ZERO;
  }

  /**
   * Клиенты с остатками. Валюта известна только здесь, поэтому список отдаёт служба,
   * а не репозиторий напрямую: контроллеру незачем знать, что счёт бывает не один.
   */
  async listClients(filter: ClientFilter): Promise<{
    rows: ClientWithBalance[];
    total: number;
  }> {
    return this.repository.listClients(filter, DEFAULT_CURRENCY);
  }

  async listPartners(filter: PartnerFilter): Promise<{
    rows: PartnerWithBalance[];
    total: number;
  }> {
    return this.repository.listPartners(filter, DEFAULT_CURRENCY);
  }

  /**
   * Названия клиентов по идентификаторам — для чужих модулей, показывающих список,
   * в котором клиент упомянут ссылкой.
   *
   * Публичный вход вместо чтения таблицы `clients` соседним модулем
   * (ARCHITECTURE.md, «Границы модулей»).
   */
  async clientNamesOf(ids: readonly ClientId[]): Promise<Map<string, string>> {
    return this.repository.clientNamesOf(ids);
  }

  /**
   * Имена партнёров по идентификаторам, вместе с псевдонимом.
   *
   * **Только для административного контура.** Настоящее имя партнёра клиенту
   * не показывается ни в каком виде
   * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)):
   * за это отвечает обработчик, решающий, кому отдаёт ответ.
   */
  async partnerNamesOf(
    ids: readonly PartnerId[],
  ): Promise<Map<string, { name: string; displayName: string | null }>> {
    return this.repository.partnerNamesOf(ids);
  }

  /**
   * Псевдонимы партнёров, готовых принимать вызовы — то, из чего клиент строит порядок.
   *
   * Публичный вход вместо чтения таблицы псевдонимов соседним модулем
   * (ARCHITECTURE.md, «Границы модулей»).
   */
  async listOfferedAliases(): Promise<(PartnerAliasRow & { listensToRecordings: boolean })[]> {
    return this.repository.listOfferedAliases();
  }

  /**
   * Клиент, которым владеет учётная запись.
   *
   * Единственный вход клиентского контура: идентификатор клиента там нигде не
   * принимается — он выводится отсюда, из сессии. Иначе клиенту пришлось бы верить
   * на слово, чей счёт он открывает.
   *
   * Нет клиента — `404`, а не пустой ответ: учётная запись с ролью `client`,
   * к которой клиент ещё не привязан, — это незавершённое заведение, и человек
   * обязан увидеть, что дело не в его настройках.
   */
  /**
   * Клиент по идентификатору, полученному **от опознанного предъявителя**.
   *
   * Идентификатор сюда приходит из машинного ключа (ADR-0044) — из его владельца,
   * а не из запроса. Подставлять сюда значение из тела или адреса нельзя: тогда
   * это будет способ открыть чужой счёт, и весь смысл `requireClientOwnedBy`
   * пропадёт.
   */
  async requireClient(clientId: ClientId): Promise<ClientRow> {
    const client = await this.repository.findClient(clientId);
    if (client === undefined) throw notFound('Клиент не найден');
    return client;
  }

  async requireClientOwnedBy(userId: UserId): Promise<ClientRow> {
    const own = await this.repository.findClientOwnedBy(userId);
    const client = own === undefined ? undefined : await this.repository.findClient(own.id);
    if (client === undefined) throw notFound('Клиент не найден');
    return client;
  }

  /**
   * Партнёр, которым владеет учётная запись.
   *
   * Вход партнёрского контура, устроенный так же, как клиентский: идентификатор партнёра
   * в `/partner/*` не принимается нигде — он выводится из сессии. Разница с обработчиками
   * вида `/partners/:id/*` не косметическая: туда партнёр допущен и там ему приходится
   * сверять владение на каждом входе, а здесь подставить нечего.
   *
   * Нет партнёра — `404`: учётная запись с ролью `partner` без привязанного партнёра
   * это незавершённое заведение, и человек обязан увидеть, что дело не в его настройках.
   */
  async requirePartnerOwnedBy(userId: UserId): Promise<PartnerRow> {
    const own = await this.repository.findPartnerOwnedBy(userId);
    const partner = own === undefined ? undefined : await this.repository.findPartner(own.id);
    if (partner === undefined) throw notFound('Партнёр не найден');
    return partner;
  }

  /**
   * Псевдоним партнёра — то единственное, чем его знает клиент (ADR-0014).
   *
   * Партнёру он показывается в его же кабинете: под этим именем его выбирают,
   * и не знать его — значит не понимать, о ком речь в разговоре с площадкой.
   */
  async partnerAliasOf(partnerId: PartnerId): Promise<string | undefined> {
    return this.repository.findPartnerAlias(partnerId);
  }

  /**
   * Заводит клиента: запись и счёт.
   *
   * **Один владелец — один клиент**, по той же причине, что и у партнёра:
   * `findClientOwnedBy` берёт первую попавшуюся строку, и второй клиент у того же
   * человека оказался бы для него самого недоступен — он не увидел бы ни своих каналов,
   * ни своих записей разговоров.
   */
  async createClient(draft: {
    ownerUserId: UserId;
    name: string;
    overdraftLimit: MoneyAmount;
  }): Promise<ClientRow> {
    const existing = await this.repository.findClientOwnedBy(draft.ownerUserId);
    if (existing !== undefined) {
      throw conflict('У этой учётной записи уже есть клиент');
    }

    const client = await this.repository.createClient({
      ownerUserId: draft.ownerUserId,
      name: draft.name,
      status: 'pending',
      overdraftLimit: draft.overdraftLimit,
    });
    // Счёт заводится сразу: клиент без счёта — участник, которому некуда начислить.
    await this.accountOf('client', client.id);

    return client;
  }

  /**
   * Смена разрешённого минуса.
   *
   * До появления метода эта величина задавалась **только при заведении** и потом
   * не менялась ничем: опечатка в разрядах означала кредит, который нечем отозвать.
   *
   * Действие денежное, поэтому журналируется ([CLAUDE.md](../../../../../CLAUDE.md),
   * «Доменные правила»): в журнале остаётся и прежний предел, и новый.
   *
   * Уменьшение до величины меньше текущего долга **разрешено** и намеренно: это способ
   * сказать «больше в долг не даём». Уже потраченное при этом никуда не девается,
   * а новые вызовы просто перестают проходить по резерву.
   */
  async changeOverdraftLimit(
    clientId: ClientId,
    limit: MoneyAmount,
    actor: { userId: UserId; role: UserRole },
  ): Promise<ClientRow> {
    const client = await this.repository.findClient(clientId);
    if (client === undefined) throw notFound('Клиент не найден');

    if (client.overdraftLimit === limit) return client;

    const updated = await this.repository.setOverdraftLimit(clientId, limit);
    if (updated === undefined) throw notFound('Клиент не найден');

    await this.audit.record({
      action: 'client.overdraft_changed',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { overdraft_limit: Money.format(client.overdraftLimit) },
      after: { overdraft_limit: Money.format(limit) },
    });

    return updated;
  }

  /**
   * Смена состояния клиента — переход, которого в системе не было вовсе.
   *
   * Клиент заводится `pending`, а маршрутизация требует `active` и от канала,
   * и от самого клиента: `findRoutableChannel` и `findActiveChannel` проверяют оба.
   * Пока этого метода не было, заведённый клиент не мог совершить ни одного вызова,
   * и починить это можно было только правкой в базе.
   *
   * `closed` терминально, как и у партнёра: у закрытого клиента остаётся история
   * проводок, и тихое возвращение его в работу — не то, чего ждут от выпадающего списка.
   *
   * **Закрытие отзывает ключи клиентского API** ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)).
   * Человек, закрывая клиента, закрывает и вход его диспетчерской: иначе остаётся дверь,
   * о которой в этот момент никто не думает, — ровно та же мысль, что и у узла,
   * выводимого из эксплуатации. Приостановка ключей не трогает: она обратима, а отзыв нет.
   */
  async changeClientStatus(
    clientId: ClientId,
    status: ClientStatus,
    actor: { userId: UserId; role: UserRole },
  ): Promise<ClientRow> {
    const client = await this.repository.findClient(clientId);
    if (client === undefined) throw notFound('Клиент не найден');

    if (client.status === status) return client;

    if (client.status === 'closed') {
      throw conflict('Клиент закрыт: это состояние окончательное');
    }

    const updated = await this.repository.setClientStatus(clientId, status);
    if (updated === undefined) throw notFound('Клиент не найден');

    await this.audit.record({
      action: 'client.status_changed',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { status: client.status },
      after: { status },
    });

    // После записи в журнал, а не до: отзыв ключей — следствие закрытия, и в журнале
    // он обязан идти следом, а не предшествовать причине.
    if (status === 'closed') {
      await this.machine.revokeAllOf(clientId, actor.userId, actor.role);
    }

    return updated;
  }

  /**
   * Заводит партнёра: запись, псевдоним и счёт.
   *
   * **Один владелец — один партнёр.** Схема этого не требует, а код требует:
   * `findPartnerOwnedBy` берёт первую попавшуюся строку, и второй партнёр у того же
   * человека оказался бы для него самого недоступен — например, он не смог бы объявить
   * по нему намерение слушать записи. Отказ на входе дешевле, чем запись, которую
   * потом не открыть.
   */
  async createPartner(draft: {
    ownerUserId: UserId;
    name: string;
    displayName: string;
  }): Promise<PartnerRow> {
    const existing = await this.repository.findPartnerOwnedBy(draft.ownerUserId);
    if (existing !== undefined) {
      throw conflict('У этой учётной записи уже есть партнёр');
    }

    const partner = await this.repository.createPartner({
      ownerUserId: draft.ownerUserId,
      name: draft.name,
      status: 'pending',
    });
    await this.repository.setPartnerAlias(partner.id, draft.displayName);
    // Счёт заводится сразу: партнёр без счёта — участник, которому некуда начислить.
    await this.accountOf('partner', partner.id);

    return partner;
  }

  /**
   * Переименование псевдонима партнёра.
   *
   * Псевдоним — **единственное, что клиент вообще знает о партнёре**
   * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)), и до появления
   * этого метода он задавался только при заведении: опечатка оставалась навсегда
   * и на глазах у всех клиентов.
   *
   * Псевдоним уникален на всю площадку — иначе один поставщик выглядел бы у клиента
   * несколькими разными, и распределение трафика поехало бы. Занятое имя отвергается
   * с названной причиной, а не общим «такая запись уже существует».
   */
  async renamePartnerAlias(
    partnerId: PartnerId,
    displayName: string,
    actor: { userId: UserId; role: UserRole },
  ): Promise<string> {
    const partner = await this.repository.findPartner(partnerId);
    if (partner === undefined) throw notFound('Партнёр не найден');

    const previous = await this.repository.findPartnerAlias(partnerId);
    if (previous === displayName) return displayName;

    const taken = await this.repository.findPartnerByAlias(displayName);
    if (taken !== undefined && taken !== partnerId) {
      throw conflict('Такой псевдоним уже занят другим партнёром');
    }

    const updated = await this.repository.renamePartnerAlias(partnerId, displayName);
    // Псевдоним заводится вместе с партнёром, но строки может не быть: тогда её надо
    // создать, а не молча отчитаться об успехе.
    if (updated === undefined) {
      await this.repository.setPartnerAlias(partnerId, displayName);
    }

    await this.audit.record({
      action: 'partner.alias_renamed',
      entityType: 'partner',
      entityId: partnerId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { display_name: previous ?? null },
      after: { display_name: displayName },
    });

    return displayName;
  }

  /**
   * Смена состояния партнёра — переход, которого в системе не было вовсе.
   *
   * Партнёр заводится `pending`, а и регистрация его шлюза, и отбор SIM требуют
   * `verified`. Пока этого метода не было, заведённый партнёр не мог терминировать
   * ни одного вызова, и починить это можно было только правкой в базе.
   *
   * `closed` терминально: у закрытого партнёра остаётся история выплат, и тихое
   * возвращение его в работу — не то, что администратор ожидает от выпадающего
   * списка. Понадобится вернуть — заводится новый партнёр.
   */
  async changePartnerStatus(
    partnerId: PartnerId,
    status: PartnerStatus,
    actor: { userId: UserId; role: UserRole },
  ): Promise<PartnerRow> {
    const partner = await this.repository.findPartner(partnerId);
    if (partner === undefined) throw notFound('Партнёр не найден');

    if (partner.status === status) return partner;

    if (partner.status === 'closed') {
      throw conflict('Партнёр закрыт: это состояние окончательное');
    }

    const updated = await this.repository.setPartnerStatus(partnerId, status);
    if (updated === undefined) throw notFound('Партнёр не найден');

    await this.audit.record({
      action: 'partner.status_changed',
      entityType: 'partner',
      entityId: partnerId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { status: partner.status },
      after: { status },
    });

    return updated;
  }

  async listEntries(
    accountId: AccountId,
    limit = 100,
    offset = 0,
  ): Promise<{ rows: LedgerEntryWithTransaction[]; total: number }> {
    return this.repository.listEntries(accountId, limit, offset);
  }

  /**
   * Сверка остатков с журналом.
   *
   * Расхождение — инцидент с отчётом, а не повод подогнать число: если остаток
   * разошёлся с проводками, важно понять, какое движение прошло мимо журнала.
   */
  async reconcile(): Promise<{ accountId: AccountId; stored: bigint; computed: bigint }[]> {
    return this.repository.findBalanceDiscrepancies();
  }

  // --- Проверки --------------------------------------------------------------

  private validate(draft: TransactionDraft): void {
    if (draft.lines.length < 2) {
      throw validationFailed('Операция обязана иметь не менее двух проводок');
    }
    if (draft.idempotencyKey.trim() === '') {
      throw validationFailed('Ключ идемпотентности не может быть пустым');
    }

    const accountIds = new Set<string>();
    for (const line of draft.lines) {
      if (Money.isZero(line.amount)) {
        throw validationFailed('Проводка на ноль не имеет смысла');
      }
      if (accountIds.has(line.accountId)) {
        // Две проводки на один счёт в одной операции — почти всегда ошибка сборки
        // проводок; сложить их заранее и проще, и честнее.
        throw validationFailed('Счёт встречается в операции дважды');
      }
      accountIds.add(line.accountId);
    }

    // Главный инвариант двойной записи: деньги не возникают и не исчезают.
    const total = Money.sum(draft.lines.map((line) => line.amount));
    if (!Money.isZero(total)) {
      throw validationFailed('Сумма проводок операции обязана быть нулём', {
        details: { total: Money.format(total) },
      });
    }
  }

  private assertSameCurrency(locked: readonly AccountRow[]): void {
    const currencies = new Set(locked.map((account) => account.currency));
    if (currencies.size > 1) {
      // Проводки между валютами не сходятся: нужен отдельный счёт переоценки,
      // а его в модели пока нет — значит и операции такой быть не должно.
      throw validationFailed('Проводки операции должны быть в одной валюте');
    }
  }

  /**
   * Овердрафт проверяется у клиента и только после правки остатка.
   *
   * Проверять до — значит проверять устаревшее значение: между чтением и записью
   * остаток мог измениться параллельной операцией, а именно так и уходят в минус
   * на сотне одновременных звонков.
   */
  private async assertWithinOverdraft(account: AccountRow, balance: MoneyAmount): Promise<void> {
    if (account.kind !== 'client' || account.ownerId === null) return;
    if (Money.compare(balance, Money.ZERO) >= 0) return;

    const client = await this.repository.findClient(account.ownerId as ClientId);
    const limit = client?.overdraftLimit ?? Money.ZERO;

    // Предел хранится положительным, а остаток отрицательный: сравниваем модули.
    if (Money.compare(Money.negate(balance), limit) > 0) {
      throw conflict('Недостаточно средств на балансе', {
        details: { balance: Money.format(balance), overdraft_limit: Money.format(limit) },
      });
    }
  }
}
