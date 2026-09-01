/**
 * Сборка приложения.
 *
 * Вынесено из `main.ts`, чтобы тесты поднимали ровно то же приложение, что и production,
 * а не свою урезанную сборку. Настройка, включённая только в `main.ts`, не проверяется
 * ни одним тестом — и ломается незаметно.
 */

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from '@zvonix/logger';
import { AppModule } from './app.module.js';
import { registerCorrelationId } from './http/correlation-id.hook.js';
import { APP_CONFIG, APP_LOGGER, type Config } from './infra/tokens.js';

/** Верхняя граница тела запроса. Больше в этом API отправлять нечего. */
const MAX_BODY_BYTES = 256 * 1024;

export interface BuiltApplication {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly logger: Logger;
}

export async function buildApplication(): Promise<BuiltApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: MAX_BODY_BYTES,
    // Приложение работает за обратным прокси, и без этого `request.ip` — адрес прокси.
    // В журнал аудита попадал бы один и тот же адрес у всех действий.
    trustProxy: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Свой логгер (ADR-0004). Штатный вывод NestJS оставлен только для сообщений
    // самого фреймворка при старте.
    bufferLogs: true,
  });

  const config = app.get<Config>(APP_CONFIG);
  const logger = app.get<Logger>(APP_LOGGER);

  registerCorrelationId(app.getHttpAdapter().getInstance());

  // Без этого `onApplicationShutdown` не вызывается, и пул соединений остаётся
  // открытым после SIGTERM: оркестратор добьёт процесс по таймауту.
  app.enableShutdownHooks();

  return { app, config, logger };
}
