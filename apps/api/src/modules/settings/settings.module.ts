/**
 * Настройки площадки (ADR-0031).
 *
 * Глобальный модуль: настройки читают и почта, и защита форм, и оба процесса —
 * API и воркер. Импортировать его в каждый модуль отдельно значило бы завести
 * зависимость, о которой никто не помнит.
 */

import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsRepository } from './settings.repository.js';
import { SettingsService } from './settings.service.js';

@Global()
@Module({
  imports: [AuditModule],
  providers: [SettingsService, SettingsRepository],
  exports: [SettingsService],
})
export class SettingsModule {}
