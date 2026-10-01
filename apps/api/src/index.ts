/**
 * Публичная поверхность control plane для других процессов монорепозитория.
 *
 * Нужна ровно одному потребителю — `apps/worker` (ADR-0020). Воркер поднимает контекст
 * приложения над **теми же** модулями, что и API: проводки пишет тот же `billing`,
 * объекты удаляет тот же `recordings`. Своя копия доменной логики в фоновом процессе —
 * это способ получить две разные тарификации одного вызова.
 *
 * Здесь перечислено только то, что воркеру действительно нужно. Экспортировать модули
 * целиком не следует: чем шире эта поверхность, тем легче фоновому процессу начать
 * делать то, чего он делать не должен.
 */

export { InfraModule } from './infra/infra.module.js';
export {
  assertNoEvictionPolicy,
  createProbeConnection,
  redisConnectionOptions,
  RedisService,
  type ConfigReader,
} from './infra/redis.js';
export {
  APP_CONFIG,
  APP_LOGGER,
  PROCESS_COMPONENT,
  type Config,
  type Logger,
} from './infra/tokens.js';

export { BillingModule } from './modules/billing/billing.module.js';
export { ReservationService, EXPIRY_SWEEP_LIMIT } from './modules/billing/reservation.service.js';

export { TelephonyModule } from './modules/telephony/telephony.module.js';
export { CdrService } from './modules/telephony/cdr.service.js';
export { QualityService } from './modules/telephony/quality.service.js';

export { IdentityModule } from './modules/identity/identity.module.js';
export { IdentityService, SESSION_SWEEP_LIMIT } from './modules/identity/identity.service.js';

export { CatalogModule } from './modules/catalog/catalog.module.js';
export {
  OperatorResolverService,
  STALE_SWEEP_LIMIT,
} from './modules/catalog/operator-resolver.service.js';
export { NumberingPlanService } from './modules/catalog/numbering-plan.service.js';

export { SettingsModule } from './modules/settings/settings.module.js';
export { SettingsService } from './modules/settings/settings.service.js';

export { MailModule } from './modules/mail/mail.module.js';
export { MailService } from './modules/mail/mail.service.js';

export { LimitsModule } from './modules/limits/limits.module.js';
export { LimitService, COUNTER_RETENTION_DAYS } from './modules/limits/limit.service.js';

export { NodesModule } from './modules/nodes/nodes.module.js';
export { NodesService } from './modules/nodes/nodes.service.js';

export { RecordingsModule } from './modules/recordings/recordings.module.js';
export {
  RecordingsService,
  RETENTION_SWEEP_LIMIT,
} from './modules/recordings/recordings.service.js';
export { NotificationsModule } from './modules/notifications/notifications.module.js';
export { LowBalanceService } from './modules/notifications/low-balance.service.js';
export { ApplicationsModule } from './modules/applications/applications.module.js';
export { ApplicationsService } from './modules/applications/applications.service.js';
