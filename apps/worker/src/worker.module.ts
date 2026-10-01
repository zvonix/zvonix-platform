/**
 * Состав фонового процесса (ADR-0020).
 *
 * Импортируются **те же** доменные модули, что и в API: проводки пишет тот же `billing`,
 * объекты удаляет тот же `recordings`. Контроллеров здесь нет и быть не должно — воркер
 * не слушает порт, он выполняет расписание.
 */

import { Module } from '@nestjs/common';
import {
  ApplicationsModule,
  BillingModule,
  CatalogModule,
  IdentityModule,
  InfraModule,
  LimitsModule,
  MailModule,
  NodesModule,
  NotificationsModule,
  RecordingsModule,
  SettingsModule,
  TelephonyModule,
} from '@zvonix/api';
import { SchedulerService } from './scheduler.service.js';
import { BackgroundTasks } from './tasks.js';

@Module({
  imports: [
    // Имя компонента в логах: иначе записи воркера неотличимы от записей API,
    // а оба поднимают одни и те же доменные модули.
    InfraModule.forComponent('worker'),
    BillingModule,
    CatalogModule,
    TelephonyModule,
    IdentityModule,
    LimitsModule,
    MailModule,
    NodesModule,
    RecordingsModule,
    // Почта берёт узел, порт и пароль отсюда (ADR-0031).
    SettingsModule,
    // Допуск партнёров без администратора (partners.auto_approve).
    ApplicationsModule,
    // Письмо клиенту о низком балансе (ADR-0060).
    NotificationsModule,
  ],
  providers: [BackgroundTasks, SchedulerService],
})
export class WorkerModule {}
