import { Module } from '@nestjs/common';
import { MailRepository } from './mail.repository.js';
import { MailService } from './mail.service.js';

/**
 * Почта (ADR-0029): очередь писем в базе, отправка воркером по SMTP.
 *
 * Контроллеров нет: письма никто не запрашивает снаружи — их пишут доменные службы
 * вместе со своими событиями.
 */
@Module({
  providers: [MailService, MailRepository],
  exports: [MailService],
})
export class MailModule {}
