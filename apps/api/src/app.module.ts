import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './http/auth.guard.js';
import { DomainExceptionFilter } from './http/domain-exception.filter.js';
import { InfraModule } from './infra/infra.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';

@Module({
  imports: [InfraModule, AuditModule, IdentityModule, CatalogModule, BillingModule, HealthModule],
  providers: [
    // Доступ закрыт по умолчанию: обработчик открывается пометкой `@Public()`.
    // Обратный порядок оставляет незакрытым один обработчик, и узнают об этом не первыми.
    { provide: APP_GUARD, useClass: AuthGuard },
    // Единственное место превращения доменной ошибки в HTTP-ответ (ADR-0003).
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
