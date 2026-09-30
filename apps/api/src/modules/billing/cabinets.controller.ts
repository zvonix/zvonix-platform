/**
 * Какие кабинеты открыты вошедшему
 * ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Кабинет открывает владение карточкой, а не роль, и «чья это карточка» знает только
 * биллинг — поэтому ответ живёт здесь, а не в `GET /auth/me`: учётные записи
 * о карточках не знают, и обратная стрелка замкнула бы модули в кольцо.
 *
 * Пометки доступа нет намеренно: спрашивать может любой вошедший. Сотруднику площадки
 * ответ пустой — кабинетов у него не бывает, и кабинет браузера не рисует ему
 * переключатель.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { isStaffRole, parseId, type ClientStatus, type PartnerStatus } from '@zvonix/shared';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import type { Principal } from '../identity/identity.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingService } from './billing.service.js';

interface CabinetsView {
  readonly client: {
    readonly id: string;
    readonly name: string;
    readonly status: ClientStatus;
  } | null;
  /**
   * Партнёру показывается его псевдоним: под ним его видят клиенты (ADR-0014),
   * и переключатель подписан тем, о ком речь в разговоре с площадкой.
   */
  readonly partner: {
    readonly id: string;
    readonly display_name: string | null;
    readonly status: PartnerStatus;
  } | null;
  /**
   * Можно ли подать заявку на недостающий кабинет. Для второго кабинета решает
   * настройка площадки; без кабинетов вовсе заявка на первый открыта всегда.
   */
  readonly second_cabinet_open: boolean;
}

/** Не больше страницы списка учётных записей. */
const OWNERS_MAX = 200;

interface OwnerCabinetsView {
  readonly user_id: string;
  readonly client: { id: string; name: string; status: ClientStatus } | null;
  readonly partner: { id: string; name: string; status: PartnerStatus } | null;
}

@Controller()
export class CabinetsController {
  constructor(
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Чьи это карточки — для списка учётных записей сотрудников: без него «участник»
   * не отличает клиента от партнёра. Идентификаторы — через запятую, не больше страницы.
   */
  @Roles('admin', 'support')
  @Get('cabinets/owners')
  async owners(@Query('userIds') raw?: string): Promise<{ owners: OwnerCabinetsView[] }> {
    const ids = (raw ?? '')
      .split(',')
      .filter((part) => part !== '')
      .slice(0, OWNERS_MAX)
      .map((part) => parseId(part, 'user'));
    const found = await this.billing.cabinetsOfMany(ids);
    return {
      owners: ids.map((userId) => {
        const client = found.clients.find((row) => row.ownerUserId === userId);
        const partner = found.partners.find((row) => row.ownerUserId === userId);
        return {
          user_id: userId,
          client:
            client === undefined
              ? null
              : { id: client.id, name: client.name, status: client.status },
          partner:
            partner === undefined
              ? null
              : { id: partner.id, name: partner.name, status: partner.status },
        };
      }),
    };
  }

  @Get('me/cabinets')
  async mine(@CurrentUser() user: Principal): Promise<{ cabinets: CabinetsView }> {
    if (isStaffRole(user.role)) {
      return { cabinets: { client: null, partner: null, second_cabinet_open: false } };
    }

    const owned = await this.billing.cabinetsOf(user.userId);
    const [client, partner, alias, allowed] = await Promise.all([
      owned.client === undefined ? undefined : this.billing.requireClientOwnedBy(user.userId),
      owned.partner === undefined ? undefined : this.billing.requirePartnerOwnedBy(user.userId),
      owned.partner === undefined ? undefined : this.billing.partnerAliasOf(owned.partner),
      this.settings.cabinets(),
    ]);
    const secondCabinetOpen =
      owned.partner !== undefined && owned.client === undefined
        ? allowed.partnerMayAddClient
        : owned.client !== undefined && owned.partner === undefined
          ? allowed.clientMayAddPartner
          : owned.client === undefined;

    return {
      cabinets: {
        client:
          client === undefined ? null : { id: client.id, name: client.name, status: client.status },
        partner:
          partner === undefined
            ? null
            : { id: partner.id, display_name: alias ?? null, status: partner.status },
        second_cabinet_open: secondCabinetOpen,
      },
    };
  }
}
