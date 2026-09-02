/**
 * Сборка фонового процесса.
 *
 * Вынесено из `main.ts` по той же причине, что и у API: проверки обязаны поднимать
 * ровно то, что уезжает в production. Настройка, включённая только в точке входа,
 * не покрыта ни одним тестом и ломается незаметно.
 */

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
  APP_CONFIG,
  APP_LOGGER,
  assertNoEvictionPolicy,
  createProbeConnection,
  type Config,
  type Logger,
} from '@zvonix/api';
import { dependencyUnavailable } from '@zvonix/shared';
import { SchedulerService } from './scheduler.service.js';
import { WorkerModule } from './worker.module.js';

export interface BuiltWorker {
  readonly context: INestApplicationContext;
  readonly scheduler: SchedulerService;
  readonly config: Config;
  readonly logger: Logger;
}

/**
 * Поднимает контекст приложения **без запуска расписания**.
 *
 * Разделение намеренное: проверкам нужен собранный контейнер, чтобы дёргать проходы
 * поимённо, а не настоящее расписание, тикающее в фоне посреди теста.
 */
export async function buildWorker(): Promise<BuiltWorker> {
  const context = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    // Ошибку провайдера NestJS по умолчанию перехватывает и завершает процесс сам,
    // до вызывающего кода: неверная конфигурация выглядела бы молчаливым выходом.
    abortOnError: false,
  });

  // Без этого `onApplicationShutdown` не вызывается, и по SIGTERM процесс умер бы,
  // не дождавшись текущего прохода и не закрыв соединения.
  context.enableShutdownHooks();

  return {
    context,
    scheduler: context.get(SchedulerService),
    config: context.get<Config>(APP_CONFIG),
    logger: context.get<Logger>(APP_LOGGER),
  };
}

/**
 * Проверяет пригодность Redis до запуска расписания.
 *
 * Отдельным соединением и до старта очереди. Проверяются две разные вещи, и путать их
 * нельзя: **доступен ли Redis вообще** — иначе процесс встал бы на первой команде
 * очереди, выглядя запускающимся; и **годится ли его настройка** — иначе задания
 * пропадали бы молча, и узнали бы мы об этом по недосчитанным удалениям через неделю.
 */
export async function verifyRedis(config: Config, logger: Logger): Promise<void> {
  const redis = createProbeConnection(config.REDIS_URL);
  try {
    try {
      await redis.connect();
    } catch (cause) {
      throw dependencyUnavailable('Redis недоступен: расписание фоновых задач не поднять', {
        cause,
      });
    }
    await assertNoEvictionPolicy(redis, logger);
  } finally {
    await redis.quit().catch(() => {
      redis.disconnect();
    });
  }
}
