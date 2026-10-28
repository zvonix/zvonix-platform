/**
 * Какие письма получает владелец аккаунта
 * ([ADR-0104](../../../../../docs/adr/0104-pisma-nastraivaet-sam-poluchatel.md)).
 *
 * Одна строка на учётную запись; строки нет — всё по умолчанию. Рассылки читают выбор одним запросом на проход,
 * а не по запросу на письмо: у площадки сотни клиентов, и проход не должен ходить в базу сотни раз ради выключенных.
 */

import { Injectable } from '@nestjs/common';
import type { Id, MoneyAmount } from '@zvonix/shared';
import { NotificationPreferencesRepository } from './notification-preferences.repository.js';

export interface NotificationChoice {
  readonly lowBalance: boolean;
  /** Свой порог «мало денег»; пусто — порог площадки. */
  readonly lowBalanceThreshold: MoneyAmount | null;
  readonly paymentDecision: boolean;
  readonly equipmentSuspended: boolean;
  readonly poorConnection: boolean;
}

/** Изменение выбора: что не передано, не меняется. */
export type ChoiceChanges = {
  readonly [K in keyof NotificationChoice]?: NotificationChoice[K] | undefined;
};

/** Кто ничего не выбирал, получает всё — как до появления выбора (ADR-0104, п. 3). */
export const DEFAULT_CHOICE: NotificationChoice = {
  lowBalance: true,
  lowBalanceThreshold: null,
  paymentDecision: true,
  equipmentSuspended: true,
  poorConnection: true,
};

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly repository: NotificationPreferencesRepository) {}

  async of(userId: Id<'user'>): Promise<NotificationChoice> {
    return (await this.ofMany([userId])).get(userId) ?? DEFAULT_CHOICE;
  }

  /** Выбор нескольких учётных записей разом; тех, кто не выбирал, в ответе нет — у них `DEFAULT_CHOICE`. */
  async ofMany(userIds: readonly Id<'user'>[]): Promise<Map<Id<'user'>, NotificationChoice>> {
    const found = new Map<Id<'user'>, NotificationChoice>();
    for (const row of await this.repository.findMany(userIds)) {
      found.set(row.userId, {
        lowBalance: row.lowBalance,
        lowBalanceThreshold: row.lowBalanceThreshold,
        paymentDecision: row.paymentDecision,
        equipmentSuspended: row.equipmentSuspended,
        poorConnection: row.poorConnection,
      });
    }
    return found;
  }

  /** Меняет то, что передано; остальное (и явно пустое `undefined`) остаётся как было. */
  async change(userId: Id<'user'>, changes: ChoiceChanges): Promise<NotificationChoice> {
    const given = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    ) as Partial<NotificationChoice>;
    await this.repository.upsert(userId, DEFAULT_CHOICE, given);
    return this.of(userId);
  }
}
