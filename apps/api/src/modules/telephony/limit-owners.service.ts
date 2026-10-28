/**
 * Чьё правило лимита и в каком поясе считаются его окна
 * ([ADR-0102](../../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)).
 *
 * Здесь, а не в модуле лимитов: лимиты ниже биллинга и телефонии и не знают, чья линия или карта. Телефония знает:
 * линия — клиента, карта — партнёра; пояс — у самого клиента и партнёра. Тот же довод, по которому лимиты партнёра
 * живут в `PartnerLimitsController`.
 */

import { Injectable } from '@nestjs/common';
import {
  isTimeZone,
  LIMIT_TIMEZONE_FALLBACK,
  notFound,
  validationFailed,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import type { ClientRow, PartnerRow } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { LimitService } from '../limits/limit.service.js';
import { TelephonyRepository } from './telephony.repository.js';

/** Субъект нового правила — ровно один задан; проверку «ровно один» делает служба лимитов. */
export interface LimitSubject {
  readonly clientId: Id<'client'> | null;
  readonly channelId: Id<'channel'> | null;
  readonly partnerId: Id<'partner'> | null;
  readonly simCardId: Id<'simCard'> | null;
}

@Injectable()
export class LimitOwnersService {
  constructor(
    private readonly billing: BillingService,
    private readonly repository: TelephonyRepository,
    private readonly tariffs: TariffService,
    private readonly limits: LimitService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Пояс владельца субъекта: клиента — для клиента и его линии, партнёра — для партнёра и его карты. Лимит в тарифе
   * заводит сам партнёр, и пояс берётся из его же записи — `accountTimezone`.
   * Пояс не выбран — `UTC`, как считались окна до ADR-0102. Субъекта нет — `404`, как и при заведении на чужое.
   */
  async timezoneOf(subject: LimitSubject): Promise<string> {
    if (subject.clientId !== null) {
      return accountTimezone(await this.billing.requireClient(subject.clientId));
    }
    if (subject.channelId !== null) {
      const channel = await this.repository.findChannel(subject.channelId);
      if (channel === undefined) throw notFound('Канал не найден');
      return accountTimezone(await this.billing.requireClient(channel.clientId));
    }
    if (subject.partnerId !== null) {
      return accountTimezone(await this.billing.requirePartner(subject.partnerId));
    }
    if (subject.simCardId !== null) {
      const sim = await this.repository.findSim(subject.simCardId);
      if (sim === undefined) throw notFound('SIM не найдена');
      return accountTimezone(await this.billing.requirePartner(sim.partnerId));
    }
    // Субъекта нет вовсе — отказ даст служба лимитов; пояс ей при этом не важен.
    return LIMIT_TIMEZONE_FALLBACK;
  }

  /**
   * Новый пояс клиента вместе с правилами его и его линий — одной транзакцией (ADR-0102, п. 2–3). Набранное
   * за текущие сутки, неделю и месяц переносится: смена пояса лимит не обнуляет.
   */
  async setClientTimezone(
    client: ClientRow,
    timezone: string,
    actor: { userId: Id<'user'>; role: UserRole },
  ): Promise<void> {
    assertTimezone(timezone);
    const channels = await this.repository.listChannels(client.id);
    const moved = await this.repository.transaction(async (tx) => {
      await this.billing.setTimezone({ kind: 'client', id: client.id }, timezone, tx);
      return this.limits.moveToTimezone(
        { clientId: client.id, channelIds: channels.map((channel) => channel.id) },
        timezone,
        new Date(),
        tx,
      );
    });
    await this.audit.record({
      action: 'client.timezone_set',
      entityType: 'client',
      entityId: client.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { timezone: client.timezone },
      after: { timezone, limit_rules_moved: moved },
    });
  }

  /** Новый пояс партнёра — с правилами его, его карт (и снятых) и тарифов, одной транзакцией. */
  async setPartnerTimezone(
    partner: PartnerRow,
    timezone: string,
    actor: { userId: Id<'user'>; role: UserRole },
  ): Promise<void> {
    assertTimezone(timezone);
    const [sims, tariffs] = await Promise.all([
      this.repository.listSims(partner.id),
      this.tariffs.listTariffs(partner.id),
    ]);
    const moved = await this.repository.transaction(async (tx) => {
      await this.billing.setTimezone({ kind: 'partner', id: partner.id }, timezone, tx);
      return this.limits.moveToTimezone(
        {
          partnerIds: [partner.id],
          simCardIds: sims.map((sim) => sim.id),
          tariffIds: tariffs.map((tariff) => tariff.id),
        },
        timezone,
        new Date(),
        tx,
      );
    });
    await this.audit.record({
      action: 'partner.timezone_set',
      entityType: 'partner',
      entityId: partner.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { timezone: partner.timezone },
      after: { timezone, limit_rules_moved: moved },
    });
  }
}

/** Пояс аккаунта для его правил; не выбран — `UTC`, как до ADR-0102. */
export function accountTimezone(owner: { readonly timezone: string | null }): string {
  return owner.timezone ?? LIMIT_TIMEZONE_FALLBACK;
}

function assertTimezone(timezone: string): void {
  if (!isTimeZone(timezone)) throw validationFailed('Неизвестный часовой пояс');
}
