/**
 * Инфраструктура приложения: конфигурация, логгер, база.
 *
 * Модуль глобальный: эти три вещи нужны почти каждому доменному модулю, и импорт
 * инфраструктуры в каждый из них был бы шумом без смысла. Глобальность здесь —
 * исключение, а не приём: доменные модули друг друга так не подключают.
 */

import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@zvonix/config';
import { createLogger } from '@zvonix/logger';
import { DatabaseService } from './database.service.js';
import { APP_CONFIG, APP_LOGGER, type Config } from './tokens.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      // Конфигурация читается один раз при старте и проверяется целиком (ADR-0002).
      // Процесс с неверной конфигурацией не должен подниматься и обслуживать запросы.
      useFactory: () => loadConfig(),
    },
    {
      provide: APP_LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: Config) =>
        createLogger({
          level: config.LOG_LEVEL,
          format: config.LOG_FORMAT,
          component: 'api',
          base: { app: config.APP_NAME, env: config.APP_ENV },
        }),
    },
    DatabaseService,
  ],
  exports: [APP_CONFIG, APP_LOGGER, DatabaseService],
})
export class InfraModule {}
