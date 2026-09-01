/**
 * Поведение клиента к внешнему сервису определения оператора — без сети.
 *
 * Сеть здесь подменена намеренно: проверять надо реакцию на ответы источника,
 * включая те, которые вживую не воспроизвести, — отказ, мусор в теле, таймаут.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Msisdn } from '@zvonix/shared';
import { VoxlinkOperatorLookup } from './operator-lookup.js';
import type { Config, Logger } from '../../infra/tokens.js';

const MSISDN = '79130424123' as Msisdn;

const silentLogger = (): Logger => {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
};

function build(overrides: Partial<Config> = {}): VoxlinkOperatorLookup {
  const config = {
    OPERATOR_LOOKUP_ENABLED: true,
    OPERATOR_LOOKUP_URL: 'http://num.example.test/get/',
    // Темп максимальный: тесту незачем ждать, поведение очереди проверяется отдельно.
    OPERATOR_LOOKUP_RPS: 10,
    ...overrides,
  } as Config;
  return new VoxlinkOperatorLookup(config, silentLogger());
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('клиент внешнего сервиса', () => {
  it('разбирает ответ с перенесённым номером', async () => {
    // Форма ответа проверена на реальном номере: сервис сообщает и прежнего оператора.
    respondWith({
      operator: 'Сбербанк-Телеком',
      old_operator: 'МТС',
      region: 'Красноярский край',
    });

    await expect(build().lookup(MSISDN)).resolves.toEqual({
      operatorName: 'Сбербанк-Телеком',
      previousOperatorName: 'МТС',
      region: 'Красноярский край',
    });
  });

  it('обходится без необязательных полей', async () => {
    respondWith({ operator: 'МегаФон' });
    await expect(build().lookup(MSISDN)).resolves.toEqual({
      operatorName: 'МегаФон',
      previousOperatorName: undefined,
      region: undefined,
    });
  });

  it('передаёт номер в каноническом виде', async () => {
    respondWith({ operator: 'МТС' });
    await build().lookup(MSISDN);

    // Сравниваем значение как есть: клиент передаёт строку, и приведение к строке
    // здесь только скрыло бы, если однажды он начнёт передавать Request.
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://num.example.test/get/?num=79130424123',
    );
  });

  it('пустой оператор означает «источник номера не знает»', async () => {
    respondWith({ operator: '', old_operator: '', region: '' });
    await expect(build().lookup(MSISDN)).resolves.toBeUndefined();
  });

  it('не падает на отказе источника', async () => {
    // Недоступность внешнего сервиса — штатное состояние: резолвер обязан продолжить
    // работу и вернуть «оператор не подтверждён», а не уронить обработку вызова.
    respondWith({ error: 'rate limit' }, 429);
    await expect(build().lookup(MSISDN)).resolves.toBeUndefined();
  });

  it('не падает на мусоре в теле ответа', async () => {
    respondWith('<html>Service Unavailable</html>');
    await expect(build().lookup(MSISDN)).resolves.toBeUndefined();
  });

  it('не падает на обрыве соединения', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(build().lookup(MSISDN)).resolves.toBeUndefined();
  });

  it('выключенный источник не ходит в сеть вовсе', async () => {
    respondWith({ operator: 'МТС' });
    await expect(build({ OPERATOR_LOOKUP_ENABLED: false }).lookup(MSISDN)).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('держит темп ниже лимита источника', async () => {
    // Ровные десять запросов в секунду с одного адреса не похожи ни на что, кроме
    // перебора: так теряется ровно тот бесплатный ресурс, на котором всё держится.
    respondWith({ operator: 'МТС' });
    const lookup = build({ OPERATOR_LOOKUP_RPS: 5 });

    const started = Date.now();
    await Promise.all([lookup.lookup(MSISDN), lookup.lookup(MSISDN), lookup.lookup(MSISDN)]);
    const elapsed = Date.now() - started;

    // Три запроса при пяти в секунду — минимум два интервала по 200 мс.
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('неудача одного запроса не обрывает очередь', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('обрыв'))
          : Promise.resolve(new Response(JSON.stringify({ operator: 'МТС' }), { status: 200 }));
      }),
    );

    const lookup = build();
    const [first, second] = await Promise.all([lookup.lookup(MSISDN), lookup.lookup(MSISDN)]);

    expect(first).toBeUndefined();
    expect(second).toEqual({
      operatorName: 'МТС',
      previousOperatorName: undefined,
      region: undefined,
    });
  });
});
