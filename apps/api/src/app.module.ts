import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './http/auth.guard.js';
import { DomainExceptionFilter } from './http/domain-exception.filter.js';
import { WriteRateGuard } from './http/write-rate.guard.js';
import { InfraModule } from './infra/infra.module.js';
import { AuditHttpModule } from './modules/audit/audit-http.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { ApplicationsModule } from './modules/applications/applications.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { LimitsModule } from './modules/limits/limits.module.js';
import { MachineModule } from './modules/machine/machine.module.js';
import { NodesModule } from './modules/nodes/nodes.module.js';
import { RecordingsModule } from './modules/recordings/recordings.module.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { SettingsHttpModule } from './modules/settings/settings-http.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { TelephonyModule } from './modules/telephony/telephony.module.js';

@Module({
  imports: [
    InfraModule,
    AuditModule,
    AuditHttpModule,
    SettingsModule,
    SettingsHttpModule,
    IdentityModule,
    MachineModule,
    // Понадобился корню ради предела частоты изменений: защитник глобальный,
    // и служба счётчиков должна быть видна в корневом внедрении (ADR-0041).
    LimitsModule,
    NodesModule,
    TelephonyModule,
    RoutingModule,
    RecordingsModule,
    CatalogModule,
    BillingModule,
    ReportsModule,
    NotificationsModule,
    ApplicationsModule,
    HealthModule,
  ],
  providers: [
    // Доступ закрыт по умолчанию: обработчик открывается пометкой `@Public()`.
    // Обратный порядок оставляет незакрытым один обработчик, и узнают об этом не первыми.
    { provide: APP_GUARD, useClass: AuthGuard },
    // Порядок с предыдущим важен: считать можно только опознанного, поэтому предел
    // частоты идёт после проверки входа (ADR-0041).
    { provide: APP_GUARD, useClass: WriteRateGuard },
    // Единственное место превращения доменной ошибки в HTTP-ответ (ADR-0003).
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
