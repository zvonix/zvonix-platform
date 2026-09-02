import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingController } from './billing.controller.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';
import { ReservationRepository } from './reservation.repository.js';
import { ReservationService } from './reservation.service.js';

@Module({
  imports: [AuditModule],
  controllers: [BillingController],
  providers: [BillingService, BillingRepository, ReservationService, ReservationRepository],
  // Тарификация вызова на этапе 2 проводит списание через эту же службу:
  // другого пути изменить остаток в проекте нет и быть не должно.
  // Репозиторий отдаётся ради двух вещей, которые больше нигде не живут: псевдонимы
  // партнёров (ADR-0014) и «чей это клиент». Обе про таблицы биллинга, и вторая копия
  // такого правила в чужом модуле разъедется с этой на первой же правке.
  exports: [BillingService, ReservationService, BillingRepository],
})
export class BillingModule {}
