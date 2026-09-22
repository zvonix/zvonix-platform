import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { MailModule } from '../mail/mail.module.js';
import { CaptchaService } from './captcha.service.js';
import { IdentityController } from './identity.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';

@Module({
  imports: [AuditModule, LimitsModule, MailModule],
  controllers: [IdentityController],
  providers: [IdentityService, IdentityRepository, CaptchaService],
  // Экспортируется для глобального защитника: он проверяет токен на каждом запросе.
  exports: [IdentityService],
})
export class IdentityModule {}
