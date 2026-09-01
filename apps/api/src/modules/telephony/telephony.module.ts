import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NodeDirectoryController } from './node-directory.controller.js';
import { TelephonyController } from './telephony.controller.js';
import { TelephonyRepository } from './telephony.repository.js';
import { TelephonyService } from './telephony.service.js';

@Module({
  imports: [AuditModule],
  controllers: [TelephonyController, NodeDirectoryController],
  providers: [TelephonyService, TelephonyRepository],
  // Понадобится маршрутизации: она отбирает шлюзы и читает правила канала.
  exports: [TelephonyService, TelephonyRepository],
})
export class TelephonyModule {}
