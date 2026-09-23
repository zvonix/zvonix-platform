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

import { Controller, Get } from '@nestjs/common';
import { isStaffRole, type ClientStatus, type PartnerStatus } from '@zvonix/shared';
import { CurrentUser } from '../../http/request-context.js';
import type { Principal } from '../identity/identity.service.js';
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
}

@Controller()
export class CabinetsController {
  constructor(private readonly billing: BillingService) {}

  @Get('me/cabinets')
  async mine(@CurrentUser() user: Principal): Promise<{ cabinets: CabinetsView }> {
    if (isStaffRole(user.role)) return { cabinets: { client: null, partner: null } };

    const owned = await this.billing.cabinetsOf(user.userId);
    const [client, partner, alias] = await Promise.all([
      owned.client === undefined ? undefined : this.billing.requireClientOwnedBy(user.userId),
      owned.partner === undefined ? undefined : this.billing.requirePartnerOwnedBy(user.userId),
      owned.partner === undefined ? undefined : this.billing.partnerAliasOf(owned.partner),
    ]);

    return {
      cabinets: {
        client:
          client === undefined ? null : { id: client.id, name: client.name, status: client.status },
        partner:
          partner === undefined
            ? null
            : { id: partner.id, display_name: alias ?? null, status: partner.status },
      },
    };
  }
}
