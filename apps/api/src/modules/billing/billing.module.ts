import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MachineModule } from '../machine/machine.module.js';
import { BillingController } from './billing.controller.js';
import { ClientApiBillingController } from './client-api.controller.js';
import { ClientKeysController } from './client-keys.controller.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';
import { CabinetsController } from './cabinets.controller.js';
import { ClientSelfController } from './client-self.controller.js';
import { PartnerSelfController } from './partner-self.controller.js';
import { ReservationRepository } from './reservation.repository.js';
import { ReservationService } from './reservation.service.js';

@Module({
  // Машинные ключи здесь ради собственного контура клиента (ADR-0044): «чей это клиент»
  // знает только этот модуль, и обратная стрелка замкнула бы модули в кольцо.
  // Учётные записи — ради одного правила при заведении карточки: владельцем
  // не бывает сотрудник площадки (ADR-0052). Обратной стрелки нет.
  imports: [AuditModule, IdentityModule, MachineModule],
  controllers: [
    BillingController,
    CabinetsController,
    ClientSelfController,
    PartnerSelfController,
    ClientKeysController,
    ClientApiBillingController,
  ],
  providers: [BillingService, BillingRepository, ReservationService, ReservationRepository],
  // Тарификация вызова на этапе 2 проводит списание через эту же службу:
  // другого пути изменить остаток в проекте нет и быть не должно.
  // Репозиторий отдаётся ради двух вещей, которые больше нигде не живут: псевдонимы
  // партнёров (ADR-0014) и «чей это клиент». Обе про таблицы биллинга, и вторая копия
  // такого правила в чужом модуле разъедется с этой на первой же правке.
  exports: [BillingService, ReservationService, BillingRepository],
})
export class BillingModule {}
