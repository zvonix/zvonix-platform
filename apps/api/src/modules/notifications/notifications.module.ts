import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MailModule } from '../mail/mail.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { AlertsService } from './alerts.service.js';
import { LowBalanceService } from './low-balance.service.js';

/** Уведомления по условию: «на счёте мало» (ADR-0060) и тревоги администраторам (ADR-0062). */
@Module({
  imports: [
    BillingModule,
    IdentityModule,
    MailModule,
    NodesModule,
    PaymentsModule,
    ServersModule,
    SettingsModule,
    TelephonyModule,
  ],
  providers: [LowBalanceService, AlertsService],
  exports: [LowBalanceService, AlertsService],
})
export class NotificationsModule {}
