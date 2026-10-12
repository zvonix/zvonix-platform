/**
 * Открытые данные для сайта проекта ([ADR-0082](../../../../../docs/adr/0082-sayt-proekta.md)):
 * цены «от». Контакты отдаёт модуль настроек.
 */

import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { PublicPricesController } from './public-prices.controller.js';

@Module({
  imports: [BillingModule, CatalogModule, MessagingModule],
  controllers: [PublicPricesController],
})
export class SiteModule {}
