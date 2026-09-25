import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { CallRepository } from './call.repository.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';
import { CdrController } from './cdr.controller.js';
import { ClientApiCallsController } from './client-api.controller.js';
import { ClientReportController } from './client-report.controller.js';
import { CdrService } from './cdr.service.js';
import { NodeDirectoryController } from './node-directory.controller.js';
import { PartnerEquipmentController } from './partner-equipment.controller.js';
import { PartnerReportController } from './partner-report.controller.js';
import { PartnerReportService } from './partner-report.service.js';
import { QualityController } from './quality.controller.js';
import { SipTrunkController } from './sip-trunk.controller.js';
import { QualityRepository } from './quality.repository.js';
import { QualityService } from './quality.service.js';
import { TelephonyController } from './telephony.controller.js';
import { TelephonyRepository } from './telephony.repository.js';
import { TelephonyService } from './telephony.service.js';
import { TestCallController } from './test-call.controller.js';
import { TestCallRepository } from './test-call.repository.js';
import { TestCallService } from './test-call.service.js';

@Module({
  imports: [AuditModule, CatalogModule, BillingModule, LimitsModule, NodesModule],
  controllers: [
    TelephonyController,
    NodeDirectoryController,
    CdrController,
    CallsController,
    ClientReportController,
    ClientApiCallsController,
    QualityController,
    SipTrunkController,
    PartnerReportController,
    PartnerEquipmentController,
    TestCallController,
  ],
  providers: [
    TelephonyService,
    TelephonyRepository,
    CallRepository,
    CdrService,
    CallsService,
    QualityService,
    QualityRepository,
    PartnerReportService,
    TestCallService,
    TestCallRepository,
  ],
  // Понадобится маршрутизации: она отбирает шлюзы и читает правила канала.
  // `CdrService` — ради уборки вызовов без CDR: она нужна и маршрутизации на пути
  // отказа, и воркеру по расписанию (ADR-0020), и повторять её нельзя.
  exports: [TelephonyService, TelephonyRepository, CallRepository, CdrService, QualityService],
})
export class TelephonyModule {}
