import { Module } from '@nestjs/common';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { BOT_PROVIDER, type BotProvider } from './bot/bot.provider.js';
import {
  BotWebhookController,
  ClientBotController,
  StaffBotController,
} from './bot/bots.controller.js';
import { BotsRepository } from './bot/bots.repository.js';
import { BotsService } from './bot/bots.service.js';
import { MaxBotProvider } from './bot/max-bot.provider.js';
import { SimulatedBotProvider } from './bot/simulated-bot.provider.js';
import { GreenApiMessageProvider } from './green-api.provider.js';
import {
  ClientApiMessagesController,
  ClientMessagesController,
  MessengerWebhookController,
  StaffMessagesController,
} from './messages.controller.js';
import { MessagesRepository } from './messages.repository.js';
import { AccountPicker } from './account-picker.js';
import { DistributionController } from './distribution.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';
import { MessengerTariffsController } from './tariffs.controller.js';
import { MessengerTariffsRepository } from './tariffs.repository.js';
import { MessengerTariffsService } from './tariffs.service.js';
import { MESSAGE_PROVIDER, type MessageProvider } from './provider.js';
import { SimulatedMessageProvider } from './simulated.provider.js';
import { SmppServer } from './smpp/server.js';
import { ClientSmppController, StaffSmppController } from './smpp/smpp.controller.js';
import { SmppRepository } from './smpp/smpp.repository.js';
import { SmppService } from './smpp/smpp.service.js';

/**
 * Сообщения MAX через аккаунты партнёров ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Провайдер выбирается здесь и только здесь: единственное место, где он назван поимённо.
 */
@Module({
  imports: [AuditModule, BillingModule, CatalogModule, SettingsModule],
  controllers: [
    MessagingController,
    DistributionController,
    MessengerTariffsController,
    ClientMessagesController,
    ClientApiMessagesController,
    ClientSmppController,
    StaffSmppController,
    StaffMessagesController,
    MessengerWebhookController,
    StaffBotController,
    ClientBotController,
    BotWebhookController,
  ],
  providers: [
    MessagingService,
    MessagingRepository,
    MessengerTariffsService,
    MessengerTariffsRepository,
    AccountPicker,
    MessagesService,
    MessagesRepository,
    SmppRepository,
    SmppService,
    SmppServer,
    BotsRepository,
    BotsService,
    {
      provide: BOT_PROVIDER,
      inject: [APP_CONFIG, APP_LOGGER, SettingsService],
      useFactory: (config: Config, logger: Logger, settings: SettingsService): BotProvider =>
        config.MESSENGER_PROVIDER === 'simulated'
          ? new SimulatedBotProvider()
          : new MaxBotProvider(settings, logger),
    },
    {
      provide: MESSAGE_PROVIDER,
      inject: [APP_CONFIG, APP_LOGGER, SettingsService],
      useFactory: (config: Config, logger: Logger, settings: SettingsService): MessageProvider =>
        config.MESSENGER_PROVIDER === 'simulated'
          ? new SimulatedMessageProvider()
          : new GreenApiMessageProvider(settings, logger),
    },
  ],
  exports: [MessagingService, MessagesService, BotsService, SmppServer],
})
export class MessagingModule {}
