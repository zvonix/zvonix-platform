import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';

/**
 * Решение по заявкам на кабинет (ADR-0052). Стоит над учётными записями и биллингом:
 * заявка принадлежит первым, карточка — второму, а стрелки обратно нет ни от одного.
 */
@Module({
  imports: [AuditModule, BillingModule, IdentityModule, MailModule, SettingsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  // Воркеру: допуск партнёров без администратора — фоновая задача (partners.auto_approve).
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
