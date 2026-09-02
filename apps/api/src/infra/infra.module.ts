/**
 * Инфраструктура приложения: конфигурация, логгер, база.
 *
 * Модуль глобальный: эти три вещи нужны почти каждому доменному модулю, и импорт
 * инфраструктуры в каждый из них был бы шумом без смысла. Глобальность здесь —
 * исключение, а не приём: доменные модули друг друга так не подключают.
 */

import { Global, Module, type DynamicModule } from '@nestjs/common';
import { loadConfig } from '@zvonix/config';
import { createLogger } from '@zvonix/logger';
import { DatabaseService } from './database.service.js';
import { APP_CONFIG, APP_LOGGER, PROCESS_COMPONENT, type Config } from './tokens.js';

@Global()
@Module({
  providers: [
    // Переопределяется через `InfraModule.forComponent` в процессах, отличных от API.
    { provide: PROCESS_COMPONENT, useValue: 'api' },
    {
      provide: APP_CONFIG,
      // Конфигурация читается один раз при старте и проверяется целиком (ADR-0002).
      // Процесс с неверной конфигурацией не должен подниматься и обслуживать запросы.
      useFactory: () => loadConfig(),
    },
    {
      provide: APP_LOGGER,
      inject: [APP_CONFIG, PROCESS_COMPONENT],
      useFactory: (config: Config, component: string) =>
        createLogger({
          level: config.LOG_LEVEL,
          format: config.LOG_FORMAT,
          component,
          base: { app: config.APP_NAME, env: config.APP_ENV },
        }),
    },
    DatabaseService,
  ],
  exports: [APP_CONFIG, APP_LOGGER, DatabaseService],
})
export class InfraModule {
  /**
   * Та же инфраструктура для другого процесса — меняется только имя компонента в логах.
   *
   * Провайдер из динамического модуля регистрируется после статического и перекрывает
   * его по тому же токену. Проверяется тестом: молчаливое возвращение к `api` означало бы,
   * что логи воркера неотличимы от логов API, и заметили бы это в разборе аварии.
   */
  static forComponent(component: string): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: PROCESS_COMPONENT, useValue: component }],
    };
  }
}
