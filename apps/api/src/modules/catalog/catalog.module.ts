import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { OPERATOR_LOOKUP, VoxlinkOperatorLookup } from './operator-lookup.js';
import { OperatorResolverService } from './operator-resolver.service.js';
import { TariffController } from './tariff.controller.js';
import { TariffRepository } from './tariff.repository.js';
import { TariffService } from './tariff.service.js';

@Module({
  imports: [AuditModule],
  controllers: [CatalogController, TariffController],
  providers: [
    CatalogService,
    CatalogRepository,
    OperatorResolverService,
    TariffService,
    TariffRepository,
    // Единственное место, где источник определения оператора выбирается поимённо.
    { provide: OPERATOR_LOOKUP, useClass: VoxlinkOperatorLookup },
  ],
  // Резолвер понадобится маршрутизации и тарификации на следующих этапах.
  exports: [OperatorResolverService, CatalogRepository, TariffService],
})
export class CatalogModule {}
