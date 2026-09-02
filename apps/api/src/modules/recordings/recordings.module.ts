import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { NodeRecordingsController } from './node-recordings.controller.js';
import { OBJECT_STORAGE, S3ObjectStorage } from './object-storage.js';
import { RecordingsController } from './recordings.controller.js';
import { RecordingsRepository } from './recordings.repository.js';
import { RecordingsService } from './recordings.service.js';

@Module({
  imports: [AuditModule, TelephonyModule],
  controllers: [RecordingsController, NodeRecordingsController],
  providers: [
    RecordingsService,
    RecordingsRepository,
    // Единственное место, где хранилище выбирается поимённо. За интерфейсом,
    // потому что проверки не должны зависеть от живого S3 (ADR-0006).
    { provide: OBJECT_STORAGE, useClass: S3ObjectStorage },
  ],
  exports: [RecordingsService],
})
export class RecordingsModule {}
