/**
 * Виды денежных ответов, общие для административного и клиентского контуров.
 *
 * Общие они не ради экономии строк: проводка и остаток — одни и те же числа, и два
 * представления одного остатка означали бы, что где-то он однажды округлится иначе.
 * Суммы отдаются строкой в основных единицах — JSON-число потеряло бы точность
 * на больших суммах, а копейки на любых.
 */

import { Money, type MoneyAmount, type TransactionKind } from '@zvonix/shared';
import type { LedgerEntryWithTransaction } from './billing.repository.js';

export interface EntryView {
  readonly seq: string;
  readonly transaction_id: string;
  readonly amount: string;
  /** Что за операция: пополнение, списание за вызов, выплата, исправление. */
  readonly kind: TransactionKind;
  readonly description: string;
  /** На что ссылается операция — вызов, платёж. Пусто у ручных операций. */
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly created_at: string;
}

/**
 * Сколько можно потратить прямо сейчас.
 *
 * Остаток на этот вопрос не отвечает: часть средств придержана под идущие вызовы,
 * а часть допустимого — это разрешённый минус. Разбор «деньги же есть, а не звонит»
 * начинается именно отсюда.
 */
export interface FundsView {
  readonly balance: string;
  readonly overdraft_limit: string;
  readonly held: string;
  readonly available: string;
}

export function toEntryView(row: LedgerEntryWithTransaction): EntryView {
  return {
    seq: row.seq.toString(),
    transaction_id: row.transactionId,
    amount: Money.format(row.amount),
    kind: row.kind,
    description: row.description,
    reference_type: row.referenceType,
    reference_id: row.referenceId,
    created_at: row.createdAt.toISOString(),
  };
}

export function toFundsView(funds: {
  balance: MoneyAmount;
  overdraftLimit: MoneyAmount;
  held: MoneyAmount;
  available: MoneyAmount;
}): FundsView {
  return {
    balance: Money.format(funds.balance),
    overdraft_limit: Money.format(funds.overdraftLimit),
    held: Money.format(funds.held),
    available: Money.format(funds.available),
  };
}
