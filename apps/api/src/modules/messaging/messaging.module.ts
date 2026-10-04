import { Module } from '@nestjs/common';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { GreenApiMessageProvider } from './green-api.provider.js';
import {
  ClientApiMessagesController,
  ClientMessagesController,
  MessengerWebhookController,
  StaffMessagesController,
} from './messages.controller.js';
import { MessagesRepository } from './messages.repository.js';
import { MessagesService } from './messages.service.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';
import { MESSAGE_PROVIDER, type MessageProvider } from './provider.js';
import { SimulatedMessageProvider } from './simulated.provider.js';

/**
 * Сообщения MAX через аккаунты партнёров ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Провайдер выбирается здесь и только здесь: единственное место, где он назван поимённо.
 */
@Module({
  imports: [AuditModule, BillingModule, SettingsModule],
  controllers: [
    MessagingController,
    ClientMessagesController,
    ClientApiMessagesController,
    StaffMessagesController,
    MessengerWebhookController,
  ],
  providers: [
    MessagingService,
    MessagingRepository,
    MessagesService,
    MessagesRepository,
    {
      provide: MESSAGE_PROVIDER,
      inject: [APP_CONFIG, APP_LOGGER, SettingsService],
      useFactory: (config: Config, logger: Logger, settings: SettingsService): MessageProvider =>
        config.MESSENGER_PROVIDER === 'simulated'
          ? new SimulatedMessageProvider()
          : new GreenApiMessageProvider(settings, logger),
    },
  ],
  exports: [MessagingService, MessagesService],
})
export class MessagingModule {}
