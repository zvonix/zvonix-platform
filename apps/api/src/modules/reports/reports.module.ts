import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

/** Сводки по вызовам и деньгам — читающая модель (ADR-0059). */
@Module({
  imports: [BillingModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
