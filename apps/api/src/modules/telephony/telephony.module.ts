import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { CallRepository } from './call.repository.js';
import { CdrController } from './cdr.controller.js';
import { CdrService } from './cdr.service.js';
import { NodeDirectoryController } from './node-directory.controller.js';
import { TelephonyController } from './telephony.controller.js';
import { TelephonyRepository } from './telephony.repository.js';
import { TelephonyService } from './telephony.service.js';

@Module({
  imports: [AuditModule, CatalogModule, BillingModule, LimitsModule],
  controllers: [TelephonyController, NodeDirectoryController, CdrController],
  providers: [TelephonyService, TelephonyRepository, CallRepository, CdrService],
  // Понадобится маршрутизации: она отбирает шлюзы и читает правила канала.
  // `CdrService` — ради уборки вызовов без CDR: она нужна и маршрутизации на пути
  // отказа, и воркеру по расписанию (ADR-0020), и повторять её нельзя.
  exports: [TelephonyService, TelephonyRepository, CallRepository, CdrService],
})
export class TelephonyModule {}
