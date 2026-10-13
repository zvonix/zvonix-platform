import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CertificateStatusModule } from './certificate-status.module.js';
import { CertificateController } from './certificate.controller.js';
import { CertificateService } from './certificate.service.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';

/** Обновление площадки и сертификат кабинета из настроек администратора (ADR-0074, ADR-0083). */
@Module({
  imports: [AuditModule, CertificateStatusModule],
  controllers: [UpdatesController, CertificateController],
  providers: [UpdatesService, CertificateService],
})
export class UpdatesModule {}
