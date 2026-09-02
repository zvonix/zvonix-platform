/**
 * Проверка политики вытеснения Redis.
 *
 * Проверяется не «вызвана ли команда», а поведение в трёх различных случаях: политика
 * верная, политика неверная и проверить нельзя. Первое и третье внешне похожи — оба
 * заканчиваются продолжением работы, — и именно поэтому их легко перепутать в коде.
 */

import { createLogger, type Logger } from '@zvonix/logger';
import { describe, expect, it } from 'vitest';
import { assertNoEvictionPolicy, redisConnectionOptions, type ConfigReader } from './redis.js';

/** Логгер с читаемым выводом: проверки смотрят, что именно записано, а не только уровень. */
function memoryLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const logger = createLogger(
    { level: 'debug', format: 'json', component: 'проверка' },
    {
      write(chunk: string) {
        written.push(chunk);
      },
    },
  );
  return {
    logger,
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function reader(reply: unknown): ConfigReader {
  return {
    call: () => Promise.resolve(reply),
  };
}

describe('assertNoEvictionPolicy', () => {
  it('пропускает noeviction молча', async () => {
    const { logger, lines } = memoryLogger();

    await expect(
      assertNoEvictionPolicy(reader(['maxmemory-policy', 'noeviction']), logger),
    ).resolves.toBeUndefined();

    expect(lines()).toHaveLength(0);
  });

  it('отказывает при политике вытеснения: задания пропадали бы молча', async () => {
    const { logger } = memoryLogger();

    await expect(
      assertNoEvictionPolicy(reader(['maxmemory-policy', 'allkeys-lru']), logger),
    ).rejects.toThrow(/allkeys-lru/);
  });

  it('называет обнаруженную политику в сообщении — иначе непонятно, что чинить', async () => {
    const { logger } = memoryLogger();

    await expect(
      assertNoEvictionPolicy(reader(['maxmemory-policy', 'volatile-ttl']), logger),
    ).rejects.toThrow(/noeviction/);
  });

  it('не падает, когда команда CONFIG недоступна, но предупреждает', async () => {
    const { logger, lines } = memoryLogger();
    const failing: ConfigReader = {
      call: () => Promise.reject(new Error('ERR unknown command CONFIG')),
    };

    await expect(assertNoEvictionPolicy(failing, logger)).resolves.toBeUndefined();

    const warnings = lines().filter((line) => line['level'] === 'warn');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.['message'])).toContain('проверить не удалось');
  });

  it('предупреждает о неожиданном ответе, а не считает его успехом', async () => {
    const { logger, lines } = memoryLogger();

    await expect(assertNoEvictionPolicy(reader('чепуха'), logger)).resolves.toBeUndefined();

    expect(lines().filter((line) => line['level'] === 'warn')).toHaveLength(1);
  });
});

describe('redisConnectionOptions', () => {
  it('разбирает адрес: узел, порт и номер базы', () => {
    const options = redisConnectionOptions('redis://127.0.0.1:6380/7');

    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(6380);
    expect(options.db).toBe(7);
  });

  it('переносит имя пользователя и пароль', () => {
    const options = redisConnectionOptions('redis://пользователь:секрет@redis.local:6379/0');

    expect(options.username).toBe('пользователь');
    expect(options.password).toBe('секрет');
  });

  it('не оставляет отложенное подключение', () => {
    // Флаг нужен только чтобы разобрать адрес, не открывая сокет. Протащенный дальше,
    // он оставляет соединение BullMQ в состоянии «подключается»: при закрытии тот рвёт
    // сокет вместо `quit`, и висевшие команды отклоняются необработанным отказом.
    expect(redisConnectionOptions('redis://127.0.0.1:6379/1').lazyConnect).toBe(false);
  });

  it('снимает предел повторов: без этого блокирующее чтение очереди срывается', () => {
    expect(redisConnectionOptions('redis://127.0.0.1:6379/1').maxRetriesPerRequest).toBeNull();
  });
});
