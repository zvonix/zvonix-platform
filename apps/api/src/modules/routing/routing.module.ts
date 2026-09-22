import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { RoutingController } from './routing.controller.js';
import { RoutingService } from './routing.service.js';

@Module({
  imports: [TelephonyModule, CatalogModule, BillingModule, LimitsModule],
  controllers: [RoutingController],
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
