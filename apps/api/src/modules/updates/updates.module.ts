import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { CertificateStatusModule } from './certificate-status.module.js';
import { CertificateController } from './certificate.controller.js';
import { CertificateService } from './certificate.service.js';
import { GithubTokenController } from './github-token.controller.js';
import { GithubTokenService } from './github-token.service.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';

/** Обновление площадки, сертификат кабинета и резервные копии из кабинета администратора (ADR-0074, ADR-0083, ADR-0086). */
@Module({
  imports: [AuditModule, CertificateStatusModule, IdentityModule, LimitsModule],
  controllers: [UpdatesController, CertificateController, GithubTokenController, BackupsController],
  providers: [UpdatesService, CertificateService, GithubTokenService, BackupsService],
})
export class UpdatesModule {}
