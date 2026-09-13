/**
 * Обработчики настроек площадки (ADR-0031).
 *
 * Отдельно от `SettingsModule`, потому что тот глобальный и поднимается в том числе
 * воркером: контроллеры воркеру не нужны — он не слушает порт.
 */

import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { SettingsController } from './settings.controller.js';

@Module({
  imports: [MailModule],
  controllers: [SettingsController],
})
export class SettingsHttpModule {}
