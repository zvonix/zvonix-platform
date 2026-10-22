/**
 * Требования клиента к аккаунтам MAX ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)): что
 * клиенту подходит, какие аккаунты он отключил сам, и правила для выбора аккаунта под его сообщение.
 */

import { Injectable } from '@nestjs/common';
import {
  Money,
  notFound,
  type Id,
  type MoneyAmount,
  type StopLineRequirement,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { commissionOf, partnerPriceCap } from './commission.js';
import {
  RequirementsRepository,
  type RequirementsInput,
  type RequirementsRow,
} from './requirements.repository.js';

const DAY_MS = 86_400_000;

/** Что выбор аккаунта должен учесть для клиента; `undefined` у поля — ограничения нет. */
export interface ClientRules {
  readonly stopLine?: boolean;
  readonly recommendedOnly?: boolean;
  /** Предел цены партнёра, переведённый из предела цены для клиента. */
  readonly maxPartnerPrice?: MoneyAmount;
  /** Аккаунт заведён не позже этого момента. */
  readonly createdBefore?: Date;
  readonly exceptAccounts: readonly Id<'messengerAccount'>[];
  /** Никакой аккаунт не подойдёт (цена для клиента ниже наценки) — выбор сразу пустой. */
  readonly impossible?: boolean;
}

export interface RequirementsView {
  readonly stop_line: StopLineRequirement;
  readonly recommended_only: boolean;
  readonly max_price: string | null;
  readonly min_age_days: number | null;
}

export interface AccountOfferView {
  readonly id: string;
  readonly partner: string;
  readonly number: number;
  readonly price: string;
  readonly stop_line: boolean;
  readonly recommended: boolean;
  readonly age_days: number;
  readonly excluded: boolean;
  /** Почему не подходит под требования; пусто — подходит. */
  readonly reasons: string[];
}

const DEFAULTS: RequirementsInput = {
  stopLine: 'any',
  recommendedOnly: false,
  maxPrice: null,
  minAgeDays: null,
};

const viewOf = (row: RequirementsInput): RequirementsView => ({
  stop_line: row.stopLine,
  recommended_only: row.recommendedOnly,
  max_price: row.maxPrice === null ? null : Money.format(row.maxPrice),
  min_age_days: row.minAgeDays,
});

const inputOf = (row: RequirementsRow | undefined): RequirementsInput =>
  row === undefined
    ? DEFAULTS
    : {
        stopLine: row.stopLine,
        recommendedOnly: row.recommendedOnly,
        maxPrice: row.maxPrice,
        minAgeDays: row.minAgeDays,
      };

@Injectable()
export class RequirementsService {
  constructor(
    private readonly repository: RequirementsRepository,
    private readonly tariffs: TariffService,
    private readonly billing: BillingService,
    private readonly aliases: BillingRepository,
    private readonly audit: AuditService,
  ) {}

  async get(clientId: Id<'client'>): Promise<RequirementsView> {
    return viewOf(inputOf(await this.repository.find(clientId)));
  }

  async set(
    actor: { userId: Id<'user'>; role: UserRole },
    clientId: Id<'client'>,
    input: RequirementsInput,
  ): Promise<RequirementsView> {
    const before = inputOf(await this.repository.find(clientId));
    const saved = await this.repository.save(clientId, input);
    await this.audit.record({
      action: 'client_message_requirements.set',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: viewOf(before),
      after: viewOf(inputOf(saved)),
    });
    return viewOf(inputOf(saved));
  }

  async setExclusion(
    actor: { userId: Id<'user'>; role: UserRole },
    clientId: Id<'client'>,
    accountId: Id<'messengerAccount'>,
    excluded: boolean,
  ): Promise<void> {
    if (!(await this.repository.accountExists(accountId))) throw notFound('Аккаунт не найден');
    const changed = await this.repository.setExclusion(clientId, accountId, excluded);
    if (!changed) return;
    await this.audit.record({
      action: 'client_account_exclusion.set',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { account_id: accountId, excluded: !excluded },
      after: { account_id: accountId, excluded },
    });
  }

  /** Правила для выбора аккаунта; требований и отключений нет — `undefined`, выбор как раньше. */
  async rulesFor(clientId: Id<'client'>, now: Date): Promise<ClientRules | undefined> {
    const [row, exceptAccounts] = await Promise.all([
      this.repository.find(clientId),
      this.repository.exclusions(clientId),
    ]);
    const input = inputOf(row);
    if (input === DEFAULTS && exceptAccounts.length === 0) return undefined;
    let maxPartnerPrice: MoneyAmount | undefined;
    let impossible = false;
    if (input.maxPrice !== null) {
      const cap = partnerPriceCap(
        input.maxPrice,
        await this.tariffs.messageCommission(clientId, now),
      );
      if (cap === undefined) impossible = true;
      else maxPartnerPrice = cap;
    }
    return {
      ...(input.stopLine === 'any' ? {} : { stopLine: input.stopLine === 'required' }),
      ...(input.recommendedOnly ? { recommendedOnly: true } : {}),
      ...(maxPartnerPrice === undefined ? {} : { maxPartnerPrice }),
      ...(input.minAgeDays === null
        ? {}
        : { createdBefore: new Date(now.getTime() - input.minAgeDays * DAY_MS) }),
      exceptAccounts,
      ...(impossible ? { impossible: true } : {}),
    };
  }

  /**
   * Таблица «Аккаунты MAX» клиента: рабочие аккаунты подтверждённых партнёров под псевдонимами, цена для клиента и
   * почему аккаунт не подходит. Ни название аккаунта, ни номер телефона, ни партнёр наружу не попадают (ADR-0014).
   */
  async accounts(
    clientId: Id<'client'>,
    now: Date = new Date(),
  ): Promise<{ requirements: RequirementsView; accounts: AccountOfferView[] }> {
    const [row, excluded, offered, rule] = await Promise.all([
      this.repository.find(clientId),
      this.repository.exclusions(clientId),
      this.repository.offered(),
      this.tariffs.messageCommission(clientId, now),
    ]);
    const input = inputOf(row);
    const aliases = new Map(
      (
        await this.aliases.listAliasesByPartners([
          ...new Set(offered.map((account) => account.partnerId)),
        ])
      ).map((alias) => [alias.partnerId, alias.displayName]),
    );
    const verified = new Map<string, boolean>();
    const excludedSet = new Set<string>(excluded);
    const result: AccountOfferView[] = [];
    for (const account of offered) {
      const alias = aliases.get(account.partnerId);
      if (alias === undefined) continue;
      if (!verified.has(account.partnerId)) {
        const status = (await this.billing.partnerWithBalance(account.partnerId)).status;
        verified.set(account.partnerId, status === 'verified');
      }
      if (verified.get(account.partnerId) !== true) continue;

      const price = Money.add(account.price, commissionOf(account.price, rule));
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - account.createdAt.getTime()) / DAY_MS),
      );
      const reasons: string[] = [];
      if (input.stopLine === 'required' && !account.stopLine) reasons.push('без «СТОП»');
      if (input.stopLine === 'forbidden' && account.stopLine) reasons.push('со «СТОП»');
      if (input.recommendedOnly && !account.recommended) reasons.push('без рекомендованной работы');
      if (input.maxPrice !== null && Money.compare(price, input.maxPrice) > 0) {
        reasons.push('дороже вашего предела');
      }
      if (input.minAgeDays !== null && ageDays < input.minAgeDays) reasons.push('слишком новый');
      result.push({
        id: account.id,
        partner: alias,
        number: account.number,
        price: Money.format(price),
        stop_line: account.stopLine,
        recommended: account.recommended,
        age_days: ageDays,
        excluded: excludedSet.has(account.id),
        reasons,
      });
    }
    return { requirements: viewOf(input), accounts: result };
  }
}
