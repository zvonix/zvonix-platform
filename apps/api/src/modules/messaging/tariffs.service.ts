/**
 * Тарифы MAX партнёра ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)): именованный набор
 * «цена за сообщение + лимиты», назначение аккаунту и тариф по умолчанию.
 *
 * Любое изменение — в одной транзакции с пересчётом действующих условий аккаунтов (`recomputeTerms`): так условия
 * аккаунта не расходятся с тарифом. Журнал — как у остальных действий партнёра над своими условиями.
 */

import { Injectable } from '@nestjs/common';
import {
  conflict,
  MESSAGE_PRICE_MAX_RUBLES,
  MESSAGE_PRICE_MIN_RUBLES,
  MESSENGER_LIMIT_MAX,
  Money,
  notFound,
  parseId,
  validationFailed,
  type Id,
  type MoneyAmount,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { MessagingRepository, type MessengerAccountRow } from './messaging.repository.js';
import {
  MessengerTariffsRepository,
  type MessengerTariffRow,
  type TariffTerms,
} from './tariffs.repository.js';

export interface TariffActor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

export interface TariffView {
  readonly row: MessengerTariffRow;
  /** Сколько живых аккаунтов действует по этому тарифу: назначенные и (у умолчания) идущие за ним. */
  readonly accounts: number;
}

/** Условия тарифа: цена в границах продукта, лимиты положительные, минутный не больше суточного. */
export function assertTariffTerms(terms: {
  price?: MoneyAmount;
  limitPerMinute?: number | null;
  limitPerDay?: number | null;
}): void {
  if (terms.price !== undefined) {
    const min = Money.fromMajorUnits(MESSAGE_PRICE_MIN_RUBLES);
    const max = Money.fromMajorUnits(MESSAGE_PRICE_MAX_RUBLES);
    if (Money.compare(terms.price, min) < 0 || Money.compare(terms.price, max) > 0) {
      throw validationFailed(
        `Цена за сообщение — от ${MESSAGE_PRICE_MIN_RUBLES} до ${MESSAGE_PRICE_MAX_RUBLES} ₽`,
      );
    }
  }
  for (const limit of [terms.limitPerMinute, terms.limitPerDay]) {
    if (limit !== undefined && limit !== null && (limit < 1 || limit > MESSENGER_LIMIT_MAX)) {
      throw validationFailed(`Лимит — от 1 до ${String(MESSENGER_LIMIT_MAX)}`);
    }
  }
  if (
    terms.limitPerMinute !== undefined &&
    terms.limitPerMinute !== null &&
    terms.limitPerDay !== undefined &&
    terms.limitPerDay !== null &&
    terms.limitPerMinute > terms.limitPerDay
  ) {
    throw validationFailed('Лимит в минуту не может быть больше лимита в сутки');
  }
}

function view(row: MessengerTariffRow) {
  return {
    name: row.name,
    price: Money.format(row.price),
    limit_per_minute: row.limitPerMinute,
    limit_per_day: row.limitPerDay,
    is_default: row.isDefault,
  };
}

@Injectable()
export class MessengerTariffsService {
  constructor(
    private readonly repository: MessengerTariffsRepository,
    private readonly accounts: MessagingRepository,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: Id<'user'>): Promise<TariffView[]> {
    const partner = await this.billing.requirePartnerOwnedBy(userId);
    const [rows, usage] = await Promise.all([
      this.repository.listOfPartner(partner.id),
      this.repository.usage(partner.id),
    ]);
    return rows.map((row) => ({
      row,
      accounts: (usage.assigned.get(row.id) ?? 0) + (row.isDefault ? usage.followingDefault : 0),
    }));
  }

  /** Новый тариф. Первый тариф партнёра становится умолчанием сам: аккаунтам иначе не за чем идти. */
  async create(
    actor: TariffActor,
    input: TariffTerms & { name: string; isDefault: boolean },
  ): Promise<MessengerTariffRow> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    assertTariffTerms(input);

    const row = await this.repository.transaction(async (tx) => {
      const existing = await this.repository.listOfPartner(partner.id, tx);
      const makeDefault = input.isDefault || existing.length === 0;
      if (makeDefault) await this.repository.clearDefault(partner.id, tx);
      const created = await this.repository.insert(
        { ...input, partnerId: partner.id, isDefault: makeDefault },
        tx,
      );
      await this.accounts.recomputeTerms(partner.id, tx);
      await this.audit.record(
        {
          action: 'messenger_tariff.created',
          entityType: 'messenger_tariff',
          entityId: created.id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          after: view(created),
        },
        tx,
      );
      return created;
    });
    return row;
  }

  async update(
    actor: TariffActor,
    id: string,
    patch: {
      name?: string;
      price?: MoneyAmount;
      limitPerMinute?: number | null;
      limitPerDay?: number | null;
    },
  ): Promise<MessengerTariffRow> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const tariffId = parseId(id, 'messengerTariff');

    return this.repository.transaction(async (tx) => {
      const before = await this.repository.find(tariffId, tx);
      if (before?.partnerId !== partner.id) throw notFound('Тариф не найден');
      // Лимиты проверяются вместе с теми, что не меняются: минутный против прежнего суточного и наоборот.
      assertTariffTerms({
        ...(patch.price === undefined ? {} : { price: patch.price }),
        limitPerMinute:
          patch.limitPerMinute === undefined ? before.limitPerMinute : patch.limitPerMinute,
        limitPerDay: patch.limitPerDay === undefined ? before.limitPerDay : patch.limitPerDay,
      });
      const after = await this.repository.update(tariffId, patch, tx);
      if (after === undefined) throw notFound('Тариф не найден');
      await this.accounts.recomputeTerms(partner.id, tx);
      await this.audit.record(
        {
          action: 'messenger_tariff.changed',
          entityType: 'messenger_tariff',
          entityId: after.id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: view(before),
          after: view(after),
        },
        tx,
      );
      return after;
    });
  }

  async makeDefault(actor: TariffActor, id: string): Promise<void> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const tariffId = parseId(id, 'messengerTariff');
    await this.repository.transaction(async (tx) => {
      const tariff = await this.repository.find(tariffId, tx);
      if (tariff?.partnerId !== partner.id) throw notFound('Тариф не найден');
      if (tariff.isDefault) return;
      await this.repository.clearDefault(partner.id, tx);
      await this.repository.markDefault(tariffId, tx);
      await this.accounts.recomputeTerms(partner.id, tx);
      await this.audit.record(
        {
          action: 'messenger_tariff.default_changed',
          entityType: 'messenger_tariff',
          entityId: tariffId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          after: view({ ...tariff, isDefault: true }),
        },
        tx,
      );
    });
  }

  /** Удаляется неиспользуемый тариф; тариф по умолчанию — только после назначения умолчанием другого. */
  async remove(actor: TariffActor, id: string): Promise<void> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const tariffId = parseId(id, 'messengerTariff');
    await this.repository.transaction(async (tx) => {
      const tariff = await this.repository.find(tariffId, tx);
      if (tariff?.partnerId !== partner.id) throw notFound('Тариф не найден');
      if (tariff.isDefault) {
        throw conflict('Это тариф по умолчанию: сначала сделайте умолчанием другой тариф');
      }
      const usage = await this.repository.usage(partner.id, tx);
      const used = usage.assigned.get(tariffId) ?? 0;
      if (used > 0) {
        throw conflict(
          `Тариф назначен аккаунтам (${String(used)}): сначала назначьте им другой тариф`,
        );
      }
      await this.repository.remove(tariffId, tx);
      await this.audit.record(
        {
          action: 'messenger_tariff.deleted',
          entityType: 'messenger_tariff',
          entityId: tariffId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: view(tariff),
        },
        tx,
      );
    });
  }

  /** Назначает аккаунту тариф партнёра; `null` — идти за тарифом по умолчанию. */
  async assign(
    actor: TariffActor,
    accountId: string,
    tariffId: string | null,
  ): Promise<MessengerAccountRow> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const id = parseId(accountId, 'messengerAccount');
    const wanted = tariffId === null ? null : parseId(tariffId, 'messengerTariff');

    await this.repository.transaction(async (tx) => {
      const account = await this.accounts.findById(id);
      if (account?.partnerId !== partner.id || account.status === 'retired') {
        throw notFound('Аккаунт не найден');
      }
      if (wanted !== null) {
        const tariff = await this.repository.find(wanted, tx);
        if (tariff?.partnerId !== partner.id) throw notFound('Тариф не найден');
      }
      const updated = await this.accounts.setTariff(id, wanted, tx);
      if (updated === undefined) throw notFound('Аккаунт не найден');
      await this.accounts.recomputeTerms(partner.id, tx);
      await this.audit.record(
        {
          action: 'messenger_account.tariff_assigned',
          entityType: 'messenger_account',
          entityId: id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: { tariff_id: account.tariffId },
          after: { tariff_id: wanted },
        },
        tx,
      );
    });
    // Читается после фиксации: внутри транзакции другое соединение увидело бы условия до пересчёта.
    const fresh = await this.accounts.findById(id);
    if (fresh === undefined) throw notFound('Аккаунт не найден');
    return fresh;
  }
}
