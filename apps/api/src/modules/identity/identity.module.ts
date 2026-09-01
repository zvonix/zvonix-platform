import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityController } from './identity.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';

@Module({
  imports: [AuditModule],
  controllers: [IdentityController],
  providers: [IdentityService, IdentityRepository],
  // Экспортируется для глобального защитника: он проверяет токен на каждом запросе.
  exports: [IdentityService],
})
export class IdentityModule {}
