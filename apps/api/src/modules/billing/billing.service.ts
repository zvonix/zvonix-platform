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
  type MoneyAmount,
  type TransactionKind,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  BillingRepository,
  type AccountId,
  type AccountRow,
  type ClientId,
  type LedgerEntryRow,
  type LedgerTransactionRow,
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

    const posted = await this.post({
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
    });

    if (!posted.alreadyPosted) {
      await this.audit.record({
        action: 'billing.client_deposited',
        entityType: 'client',
        entityId: input.clientId,
        actorUserId: input.actorUserId,
        after: {
          amount: Money.format(input.amount),
          transaction_id: posted.transaction.id,
          idempotency_key: input.idempotencyKey,
        },
      });
    }

    return posted;
  }

  /** Счёт участника или системный. Заводится при первом обращении. */
  async accountOf(kind: AccountKind, ownerId: string | null): Promise<AccountRow> {
    return this.repository.ensureAccount(kind, ownerId, DEFAULT_CURRENCY);
  }

  async balanceOf(kind: AccountKind, ownerId: string | null): Promise<MoneyAmount> {
    const account = await this.repository.findAccount(kind, ownerId, DEFAULT_CURRENCY);
    return account?.balance ?? Money.ZERO;
  }

  async listEntries(accountId: AccountId, limit = 100): Promise<LedgerEntryRow[]> {
    return this.repository.listEntries(accountId, limit);
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
