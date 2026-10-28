import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MailModule } from '../mail/mail.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { CertificateStatusModule } from '../updates/certificate-status.module.js';
import { AlertsService } from './alerts.service.js';
import { LowBalanceService } from './low-balance.service.js';
import { PreflightService } from './preflight.service.js';
import { PlatformHealthController } from './platform-health.controller.js';
import { PlatformHealthService } from './platform-health.service.js';
import { PaymentNoticeService } from './payment-notice.service.js';
import { EquipmentNoticeService } from './equipment-notice.service.js';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationPreferencesRepository } from './notification-preferences.repository.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

/** Уведомления по условию: «на счёте мало» (ADR-0060), тревоги администраторам (ADR-0062) и выбор писем (ADR-0104). */
@Module({
  imports: [
    BillingModule,
    CertificateStatusModule,
    IdentityModule,
    MailModule,
    MessagingModule,
    NodesModule,
    PaymentsModule,
    ServersModule,
    SettingsModule,
    TelephonyModule,
  ],
  controllers: [PlatformHealthController, NotificationPreferencesController],
  providers: [
    NotificationPreferencesRepository,
    NotificationPreferencesService,
    LowBalanceService,
    AlertsService,
    PaymentNoticeService,
    EquipmentNoticeService,
    PlatformHealthService,
    PreflightService,
  ],
  exports: [
    LowBalanceService,
    AlertsService,
    PaymentNoticeService,
    EquipmentNoticeService,
    PlatformHealthService,
  ],
})
export class NotificationsModule {}
