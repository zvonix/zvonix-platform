import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingController } from './billing.controller.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';

@Module({
  imports: [AuditModule],
  controllers: [BillingController],
  providers: [BillingService, BillingRepository],
  // Тарификация вызова на этапе 2 проводит списание через эту же службу:
  // другого пути изменить остаток в проекте нет и быть не должно.
  exports: [BillingService],
})
export class BillingModule {}
