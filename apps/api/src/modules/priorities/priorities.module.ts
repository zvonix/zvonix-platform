import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CallRequirementsRepository } from './call-requirements.repository.js';
import { CallRequirementsService } from './call-requirements.service.js';
import { PrioritiesController } from './priorities.controller.js';
import { PrioritiesRepository } from './priorities.repository.js';
import { PrioritiesService } from './priorities.service.js';

/**
 * Приоритеты партнёров у клиента ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)) и его требования
 * к партнёрам для звонков ([ADR-0095](../../../../../docs/adr/0095-trebovaniya-klienta-k-partnyoram-zvonkov.md)).
 */
@Module({
  imports: [AuditModule, BillingModule],
  controllers: [PrioritiesController],
  providers: [
    PrioritiesRepository,
    PrioritiesService,
    CallRequirementsRepository,
    CallRequirementsService,
  ],
  exports: [PrioritiesService, CallRequirementsService],
})
export class PrioritiesModule {}
