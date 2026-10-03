import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ManualPaymentProvider } from './payment-provider.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsRepository } from './payments.repository.js';
import { PaymentsService } from './payments.service.js';

/** Пополнение счёта клиентом: заявки и их исход (ADR-0064). */
@Module({
  imports: [AuditModule, BillingModule, SettingsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, ManualPaymentProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
