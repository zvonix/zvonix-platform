import { Module } from '@nestjs/common';
import { CertificateStatusService } from './certificate-status.service.js';

/** Чтение состояния сертификата: для раздела настроек (ADR-0083) и тревог администраторам (ADR-0062). */
@Module({
  providers: [CertificateStatusService],
  exports: [CertificateStatusService],
})
export class CertificateStatusModule {}
