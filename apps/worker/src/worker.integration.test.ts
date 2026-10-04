/**
 * Фоновый процесс на живых Redis и PostgreSQL (ADR-0006, ADR-0020).
 *
 * Проверяется не доменная логика проходов — она покрыта проверками своих модулей, —
 * а то, что нового появилось здесь: контейнер зависимостей воркера собирается, расписание
 * заводится по реестру и приводится к нему, задание из очереди действительно доходит
 * до прохода, а проход действительно меняет базу.
 *
 * Всё это не проверяется ни подставным Redis, ни подставной базой: очередь BullMQ живёт
 * на скриптах Lua внутри Redis, и «работает с заглушкой» здесь ничего не значит.
 */

import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { createProbeConnection, PROCESS_COMPONENT, redisConnectionOptions } from '@zvonix/api';
import { prepareEnvironment, resetDatabase, withDatabase } from '@zvonix/api/testing';
import { newId } from '@zvonix/shared';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorker } from './bootstrap.js';
import { QUEUE_NAME, QUEUE_PREFIX, type SchedulerService } from './scheduler.service.js';

const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

/**
 * Проверки очищают базу Redis целиком, поэтому её номер обязан быть не нулевым.
 *
 * Та же защита, что у PostgreSQL с суффиксом `_test`, и по той же причине: команда
 * очистки, случайно направленная в рабочую базу, стирает очередь вместе с расписанием.
 */
function assertTestRedis(url: string): void {
  const database = new URL(url).pathname.replace(/^\//, '');
  if (database === '' || database === '0') {
    throw new Error(
      `Отказ: номер базы Redis «${database || 'по умолчанию'}» не годится для тестов`,
    );
  }
}

assertTestRedis(TEST_REDIS_URL);
prepareEnvironment({ REDIS_URL: TEST_REDIS_URL });

let context: INestApplicationContext | undefined;
let scheduler: SchedulerService | undefined;
let redis: Redis | undefined;

function service(): SchedulerService {
  if (scheduler === undefined) throw new Error('Воркер не поднят');
  return scheduler;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  await resetDatabase();

  redis = createProbeConnection(TEST_REDIS_URL);
  await redis.connect();
  await redis.flushdb();

  const built = await buildWorker();
  context = built.context;
  scheduler = built.scheduler;
}, 90_000);

afterAll(async () => {
  await scheduler?.stop();
  await context?.close();
  await redis?.flushdb();
  await redis?.quit();
});

describe('реестр фоновых задач', () => {
  it('собирается: все службы расписания разрешаются контейнером', () => {
    expect(
      service()
        .registeredTasks()
        .map((task) => task.name),
    ).toEqual([
      'reservations.release-expired',
      'calls.close-without-cdr',
      'nodes.retire-silent',
      'recordings.remove-expired',
      'sessions.purge-expired',
      'limits.purge-closed-windows',
      'quality.suspend-over-threshold',
      'resolutions.refresh-stale',
      'numbering-plan.refresh',
      'mail.deliver-due',
      'mail.purge-sent',
      'applications.auto-approve-partners',
      'notifications.low-balance',
      'notifications.alerts',
      'notifications.payment-decisions',
      'notifications.partner-suspension',
      'messaging.refresh-accounts',
      'servers.sample',
      'servers.purge-history',
      'auth-tokens.purge-expired',
    ]);
  });

  it('задаёт каждой задаче положительный период', () => {
    for (const task of service().registeredTasks()) {
      expect(task.everySeconds, task.name).toBeGreaterThan(0);
      expect(Number.isInteger(task.everySeconds), task.name).toBe(true);
    }
  });

  it('снимает узел с маршрутизации не реже, чем раз в половину интервала heartbeat', () => {
    // Пока узел числится живым, на него направляются вызовы, которые некому обслужить.
    const task = service()
      .registeredTasks()
      .find((candidate) => candidate.name === 'nodes.retire-silent');
    expect(task?.everySeconds).toBeLessThanOrEqual(15);
  });

  it('помечает свои записи компонентом «worker», а не «api»', () => {
    // Оба процесса поднимают одни и те же доменные модули, и без этой пометки запись
    // «резерв освобождён» не отличить: обработчик её написал или проход уборки.
    // Переопределение провайдера динамическим модулем здесь и проверяется.
    expect(context?.get<string>(PROCESS_COMPONENT)).toBe('worker');
  });

  it('падает на неизвестной задаче, а не молчит', async () => {
    await expect(service().runTask('такой-задачи-нет')).rejects.toThrow(/не найдена в реестре/);
  });
});

describe('проходы на живой базе', () => {
  it('выполняются все и не падают на пустой базе', async () => {
    for (const task of service().registeredTasks()) {
      await expect(service().runTask(task.name), task.name).resolves.toBeGreaterThanOrEqual(0);
    }
  });

  it('снимает с маршрутизации узел, замолчавший дольше порога', async () => {
    const silent = newId<'node'>();
    const alive = newId<'node'>();

    await withDatabase(async (execute) => {
      await execute(sql`
        insert into nodes (id, name, status, last_heartbeat_at)
        values (${silent}, ${`Замолчавший-${silent}`}, 'online', now() - interval '1 hour')
      `);
      await execute(sql`
        insert into nodes (id, name, status, last_heartbeat_at)
        values (${alive}, ${`Живой-${alive}`}, 'online', now())
      `);
    });

    await service().runTask('nodes.retire-silent');

    await withDatabase(async (execute) => {
      // Проверяется состояние конкретных узлов, а не число снятых: база общая
      // на все проверки, и счётчик здесь ничего бы не доказал.
      const retired = await execute(sql`select status from nodes where id = ${silent}`);
      expect(retired.rows[0]).toMatchObject({ status: 'offline' });

      const untouched = await execute(sql`select status from nodes where id = ${alive}`);
      expect(untouched.rows[0]).toMatchObject({ status: 'online' });
    });
  });
});

describe('расписание в Redis', () => {
  beforeAll(async () => {
    await service().start();
  }, 30_000);

  it('заводит ровно те задачи, что есть в реестре', async () => {
    const expected = service()
      .registeredTasks()
      .map((task) => task.name)
      .sort();
    expect(await service().scheduledTaskNames()).toEqual(expected);
  });

  it('повторный запуск не заводит второго расписания', async () => {
    await service().start();
    expect(await service().scheduledTaskNames()).toHaveLength(service().registeredTasks().length);
  });

  it('доводит задание из очереди до прохода', async () => {
    // Настоящий круг: задание кладётся в Redis, забирается рабочим процессом BullMQ
    // и попадает в реестр задач. Ни один из этих переходов не проверяется в отрыве.
    const queue = new Queue(QUEUE_NAME, {
      connection: redisConnectionOptions(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });

    try {
      const job = await queue.add('nodes.retire-silent', {});

      const deadline = Date.now() + 20_000;
      let state = await job.getState();
      while (state !== 'completed' && state !== 'failed' && Date.now() < deadline) {
        await sleep(100);
        state = await job.getState();
      }

      expect(state).toBe('completed');
    } finally {
      await queue.close();
    }
  }, 30_000);

  it('снимает расписание задачи, которой больше нет в реестре', async () => {
    const queue = new Queue(QUEUE_NAME, {
      connection: redisConnectionOptions(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });

    try {
      // Так выглядит переименованная или удалённая задача: расписание пережило
      // перезапуск, а обработчика для него больше нет.
      await queue.upsertJobScheduler('задача-из-прошлой-версии', { every: 60_000 });
      expect(await service().scheduledTaskNames()).toContain('задача-из-прошлой-версии');

      await service().stop();
      await service().start();

      expect(await service().scheduledTaskNames()).not.toContain('задача-из-прошлой-версии');
    } finally {
      await queue.close();
    }
  }, 30_000);
});
