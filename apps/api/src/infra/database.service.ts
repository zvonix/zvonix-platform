/**
 * Подключение к базе на время жизни процесса.
 *
 * Пул создаётся один раз и закрывается при остановке приложения. Незакрытый пул
 * держит процесс живым после `SIGTERM`, и оркестратор добивает его через таймаут —
 * посреди незавершённых запросов.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, type Database, type DatabaseHandle, type QueryLogger } from '@zvonix/db';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from './tokens.js';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly handle: DatabaseHandle;
  private readonly logger: Logger;

  constructor(@Inject(APP_CONFIG) config: Config, @Inject(APP_LOGGER) logger: Logger) {
    this.logger = logger.child('database');
    // Текст запроса в разработке помогает, значения параметров — нет: там адреса,
    // хеши паролей и номера абонентов. Штатный журнал Drizzle печатает и то и другое
    // мимо логгера, то есть мимо маскирования (ADR-0004), поэтому пишем сами.
    const logQuery: QueryLogger | undefined =
      config.APP_ENV === 'development'
        ? (query, parameterCount) => {
            this.logger.debug('Запрос к базе', { query, parameters: parameterCount });
          }
        : undefined;

    this.handle = createDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      ...(logQuery === undefined ? {} : { logQuery }),
      onPoolError: (error) => {
        // Пул восстановится сам, но молчать нельзя: череда таких ошибок означает,
        // что база рвёт соединения, и увидеть это нужно раньше, чем по жалобам.
        this.logger.error('Ошибка простаивающего соединения', error);
      },
    });
  }

  get db(): Database {
    return this.handle.db;
  }

  /** Готовность обслуживать запросы. Не бросает: недоступность базы — штатное состояние. */
  async isReady(): Promise<boolean> {
    return this.handle.ping();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
    this.logger.info('Пул соединений закрыт');
  }
}
