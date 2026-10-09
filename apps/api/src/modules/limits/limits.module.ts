import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DistributionRepository } from './distribution.repository.js';
import { DistributionService } from './distribution.service.js';
import { LimitController } from './limit.controller.js';
import { LimitRepository } from './limit.repository.js';
import { LimitService } from './limit.service.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * Два разных ограничения под одной крышей — и путать их нельзя.
 *
 * `RateLimitService` — защита от перебора: короткое окно, высокая частота, счётчик
 * в Redis, потеря допустима. Потребитель — вход и регистрация.
 *
 * `LimitService` — доменные квоты клиента, канала, партнёра и SIM
 * ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md)): счётчик в PostgreSQL,
 * растёт той же транзакцией, что создаёт вызов. Это защита SIM партнёра, и потеря
 * счётчика здесь означает снятую защиту.
 */
@Module({
  imports: [AuditModule],
  controllers: [LimitController],
  providers: [
    RateLimitService,
    LimitService,
    LimitRepository,
    DistributionRepository,
    DistributionService,
  ],
  exports: [RateLimitService, LimitService, DistributionService],
})
export class LimitsModule {}
