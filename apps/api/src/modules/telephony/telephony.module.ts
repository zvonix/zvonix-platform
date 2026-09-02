import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CallRepository } from './call.repository.js';
import { NodeDirectoryController } from './node-directory.controller.js';
import { TelephonyController } from './telephony.controller.js';
import { TelephonyRepository } from './telephony.repository.js';
import { TelephonyService } from './telephony.service.js';

@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [TelephonyController, NodeDirectoryController],
  providers: [TelephonyService, TelephonyRepository, CallRepository],
  // Понадобится маршрутизации: она отбирает шлюзы и читает правила канала.
  exports: [TelephonyService, TelephonyRepository, CallRepository],
})
export class TelephonyModule {}
