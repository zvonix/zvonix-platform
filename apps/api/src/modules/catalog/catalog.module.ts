import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { BlockedNumberRepository } from './blocked-numbers.repository.js';
import { BlockedNumberService } from './blocked-numbers.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { ClientPricesController } from './client-prices.controller.js';
import { MincifryPlanFile, NUMBERING_PLAN_FILE } from './numbering-plan.js';
import { NumberingPlanService } from './numbering-plan.service.js';
import { OPERATOR_LOOKUP, VoxlinkOperatorLookup } from './operator-lookup.js';
import { OperatorResolverService } from './operator-resolver.service.js';
import { PartnerPricesController } from './partner-prices.controller.js';
import { TariffController } from './tariff.controller.js';
import { TariffRepository } from './tariff.repository.js';
import { TariffService } from './tariff.service.js';
import { SettingsModule } from '../settings/settings.module.js';

@Module({
  // Биллинг — ради псевдонимов партнёров: прайс клиента называет партнёра только ими
  // (ADR-0014). Обратной зависимости нет, биллинг о каталоге не знает.
  imports: [AuditModule, BillingModule, SettingsModule],
  controllers: [
    CatalogController,
    TariffController,
    ClientPricesController,
    PartnerPricesController,
  ],
  providers: [
    CatalogService,
    CatalogRepository,
    BlockedNumberService,
    BlockedNumberRepository,
    OperatorResolverService,
    NumberingPlanService,
    TariffService,
    TariffRepository,
    // Единственное место, где источник определения оператора выбирается поимённо.
    { provide: OPERATOR_LOOKUP, useClass: VoxlinkOperatorLookup },
    // То же для файла плана нумерации: проверки подставляют сюда готовый кусок файла.
    { provide: NUMBERING_PLAN_FILE, useClass: MincifryPlanFile },
  ],
  // Резолвер понадобится маршрутизации и тарификации на следующих этапах.
  exports: [
    OperatorResolverService,
    NumberingPlanService,
    CatalogRepository,
    CatalogService,
    TariffService,
    BlockedNumberService,
  ],
})
export class CatalogModule {}
