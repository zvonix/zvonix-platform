/**
 * Деньги клиента в **машинном контуре** — `/v1`
 * ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)).
 *
 * Один обработчик, и он отвечает на единственный вопрос, который диспетчерская задаёт
 * до звонка: **хватит ли денег**. Остаток и «доступно» вместе — по отдельности они
 * порождают ровно тот вопрос, ради которого сюда и приходят: «деньги же есть, почему
 * не звонит».
 *
 * Движения по счёту здесь нет намеренно: это разбор, а разбирают люди в кабинете.
 * Отдавать машине историю списаний значит обязаться держать её формат годами ради
 * сценария, которого нет.
 */

import { Controller, Get } from '@nestjs/common';
import { parseId, type ClientStatus, type Id } from '@zvonix/shared';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { BillingService } from './billing.service.js';
import { ReservationService } from './reservation.service.js';
import { toFundsView, type FundsView } from './views.js';

/** Клиент о себе: состояние объясняет, почему не идут вызовы. */
interface ClientApiSelfView {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
}

@Controller('v1')
export class ClientApiBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly reservations: ReservationService,
  ) {}

  /**
   * Сколько можно потратить.
   *
   * Заодно освобождает просроченные резервы — так же, как кабинетный обработчик:
   * зависший из-за потерянного CDR резерв иначе тихо съедает доступное, и машина
   * увидит «денег нет» там, где они есть.
   */
  @Machine('client_api')
  @Get('balance')
  async balance(
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ client: ClientApiSelfView; funds: FundsView }> {
    const clientId: Id<'client'> = parseId(machine.ownerId, 'client');
    const client = await this.billing.requireClient(clientId);
    await this.reservations.releaseExpired();

    return {
      client: { id: client.id, name: client.name, status: client.status },
      funds: toFundsView(await this.reservations.available(client.id)),
    };
  }
}
