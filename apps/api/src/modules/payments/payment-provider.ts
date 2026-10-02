/**
 * Способ пополнения за интерфейсом ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Платёжная система добавляется здесь одним классом: `begin` создаёт платёж у неё и отдаёт
 * клиенту то, что ему показать (ссылку на оплату), а исход приходит уведомлением, которое
 * разбирает тот же класс и обращается к `PaymentsService.settle` — единственному месту,
 * где деньги попадают на счёт. Уведомление и подтверждение вручную проходят один путь, поэтому
 * идемпотентность и журнал у них общие.
 */

import { Injectable } from '@nestjs/common';
import type { PaymentProviderId } from '@zvonix/shared';
import type { PaymentRow } from './payments.repository.js';

/** Что клиенту показать после создания заявки. */
export interface PaymentStart {
  /** Идентификатор платежа у платёжной системы; у ручного способа его нет. */
  readonly externalId: string | null;
  /** Куда отправить клиента платить; у ручного способа — никуда, он переводит по реквизитам. */
  readonly payUrl: string | null;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  begin(payment: PaymentRow): Promise<PaymentStart>;
}

/** Ручной способ: клиент переводит по реквизитам, администратор подтверждает поступление. */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly id = 'manual' as const;

  begin(): Promise<PaymentStart> {
    return Promise.resolve({ externalId: null, payUrl: null });
  }
}
