import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SupportAttachmentsService } from './support-attachments.service.js';
import { SupportController } from './support.controller.js';
import { SupportRepository } from './support.repository.js';
import { SupportService } from './support.service.js';

/** Обращения клиентов и партнёров в поддержку (ADR-0085). */
@Module({
  imports: [AuditModule, BillingModule, IdentityModule, LimitsModule, MailModule, SettingsModule],
  controllers: [SupportController],
  providers: [SupportService, SupportRepository, SupportAttachmentsService],
  exports: [SupportService],
})
export class SupportModule {}
