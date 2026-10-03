import { Module } from '@nestjs/common';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { LocalObjectStorage } from './local-storage.js';
import { NodeRecordingsController } from './node-recordings.controller.js';
import { OBJECT_STORAGE, S3ObjectStorage } from './object-storage.js';
import { RecordingsController } from './recordings.controller.js';
import { RecordingsRepository } from './recordings.repository.js';
import { RecordingsService } from './recordings.service.js';
import { StorageFilesController } from './storage-files.controller.js';

@Module({
  imports: [AuditModule, BillingModule, SettingsModule, TelephonyModule],
  controllers: [RecordingsController, NodeRecordingsController, StorageFilesController],
  providers: [
    RecordingsService,
    RecordingsRepository,
    LocalObjectStorage,
    // Единственное место, где хранилище выбирается поимённо. За интерфейсом,
    // потому что проверки не должны зависеть от живого S3 (ADR-0006).
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG, LocalObjectStorage],
      useFactory: (config: Config, local: LocalObjectStorage) =>
        config.RECORDINGS_STORAGE === 's3' ? new S3ObjectStorage(config) : local,
    },
  ],
  exports: [RecordingsService],
})
export class RecordingsModule {}
