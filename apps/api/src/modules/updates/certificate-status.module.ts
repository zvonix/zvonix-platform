import { Module } from '@nestjs/common';
import { BackupStatusService } from './backup-status.service.js';
import { CertificateStatusService } from './certificate-status.service.js';
import { GithubTokenStatusService } from './github-token-status.service.js';

/** Чтение состояния, которое пишет служба обновления (сертификат, токен GitHub, резервные копии): для настроек и тревог (ADR-0062). */
@Module({
  providers: [CertificateStatusService, GithubTokenStatusService, BackupStatusService],
  exports: [CertificateStatusService, GithubTokenStatusService, BackupStatusService],
})
export class CertificateStatusModule {}
