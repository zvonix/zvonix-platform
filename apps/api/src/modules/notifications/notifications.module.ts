import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { LowBalanceService } from './low-balance.service.js';

/** Уведомления по условию (ADR-0060). Первое — «на счёте мало». */
@Module({
  imports: [BillingModule, IdentityModule, MailModule, SettingsModule],
  providers: [LowBalanceService],
  exports: [LowBalanceService],
})
export class NotificationsModule {}
