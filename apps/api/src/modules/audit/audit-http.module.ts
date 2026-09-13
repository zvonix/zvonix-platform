/**
 * Чтение журнала действий по HTTP.
 *
 * Отдельно от `AuditModule` по одной причине, и она важная: `IdentityModule` импортирует
 * `AuditModule` — записи о входе и смене состояния пишет он. Обратный импорт замкнул бы
 * круг, и его пришлось бы разрывать `forwardRef`, то есть прятать.
 *
 * Здесь круга нет: этот модуль импортирует оба, а его самого не импортирует никто.
 * Тот же приём, что и у `SettingsHttpModule`.
 */

import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { AuditController } from './audit.controller.js';
import { AuditRepository } from './audit.repository.js';

@Module({
  imports: [IdentityModule],
  controllers: [AuditController],
  providers: [AuditRepository],
})
export class AuditHttpModule {}
