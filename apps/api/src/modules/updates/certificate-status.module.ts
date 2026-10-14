import { Module } from '@nestjs/common';
import { CertificateStatusService } from './certificate-status.service.js';
import { GithubTokenStatusService } from './github-token-status.service.js';

/** Чтение состояния, которое пишет служба обновления (сертификат, токен GitHub): для настроек и тревог (ADR-0062). */
@Module({
  providers: [CertificateStatusService, GithubTokenStatusService],
  exports: [CertificateStatusService, GithubTokenStatusService],
})
export class CertificateStatusModule {}
