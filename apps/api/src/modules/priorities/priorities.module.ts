import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PrioritiesController } from './priorities.controller.js';
import { PrioritiesRepository } from './priorities.repository.js';
import { PrioritiesService } from './priorities.service.js';

/** Приоритеты партнёров у клиента ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)). */
@Module({
  imports: [AuditModule, BillingModule],
  controllers: [PrioritiesController],
  providers: [PrioritiesRepository, PrioritiesService],
  exports: [PrioritiesService],
})
export class PrioritiesModule {}
