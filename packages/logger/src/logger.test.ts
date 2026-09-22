import { describe, expect, it } from 'vitest';
import { currentCorrelationId, newCorrelationId, runWithCorrelationId } from './context.js';
import { createLogger, type Logger } from './logger.js';
import { maskPhone, redact } from './redact.js';

/** Собирает JSON-записи, которые логгер отдал бы в стандартный вывод. */
function collector() {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, stream };
}

function make(): { log: Logger; lines: Record<string, unknown>[] } {
  const { lines, stream } = collector();
  const log = createLogger(
    { level: 'debug', format: 'json', component: 'billing', base: { app: 'zvonix' } },
    stream,
  );
  return { log, lines };
}

describe('структура записи', () => {
  it('содержит все обязательные поля ADR-0004', () => {
    const { log, lines } = make();
    runWithCorrelationId('abc-123', () => {
      log.info('Проводка создана', { cdr_id: 'c-1' });
    });

    const entry = lines[0];
    expect(entry).toBeDefined();
    expect(entry?.['level']).toBe('info');
    expect(entry?.['message']).toBe('Проводка создана');
    expect(entry?.['component']).toBe('billing');
    expect(entry?.['correlation_id']).toBe('abc-123');
    expect(typeof entry?.['timestamp']).toBe('string');
    expect(entry?.['cdr_id']).toBe('c-1');
  });

  it('пишет время в UTC по ISO-8601', () => {
    const { log, lines } = make();
    log.info('проверка');
    expect(String(lines[0]?.['timestamp'])).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('не засоряет запись pid и hostname', () => {
    const { log, lines } = make();
    log.info('проверка');
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('hostname');
  });

  it('добавляет постоянные поля ко всем записям', () => {
    const { log, lines } = make();
    log.info('проверка');
    expect(lines[0]?.['app']).toBe('zvonix');
  });

  it('уважает уровень', () => {
    const { lines, stream } = collector();
    const log = createLogger({ level: 'warn', format: 'json', component: 'routing' }, stream);
    log.debug('не видно');
    log.info('не видно');
    log.warn('видно');
    log.error('видно тоже');
    expect(lines).toHaveLength(2);
  });
});

describe('сквозной идентификатор', () => {
  it('подставляется сам, без передачи в каждый вызов', () => {
    const { log, lines } = make();
    runWithCorrelationId('trace-1', () => {
      log.info('первая');
      log.info('вторая');
    });
    expect(lines.map((l) => l['correlation_id'])).toEqual(['trace-1', 'trace-1']);
  });

  it('сохраняется через асинхронную границу', async () => {
    const { log, lines } = make();
    await runWithCorrelationId('trace-async', async () => {
      await Promise.resolve();
      log.info('после await');
    });
    expect(lines[0]?.['correlation_id']).toBe('trace-async');
  });

  it('создаёт новый, если снаружи ничего не пришло', () => {
    runWithCorrelationId(undefined, () => {
      expect(currentCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('вне контекста поля просто нет', () => {
    const { log, lines } = make();
    log.info('без контекста');
    expect(lines[0]).not.toHaveProperty('correlation_id');
  });

  it('выдаёт разные идентификаторы', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe('дочерний логгер', () => {
  it('меняет компонент и наследует остальное', () => {
    const { log, lines } = make();
    log.child('routing', { node: 'node-2' }).info('маршрут выбран');
    expect(lines[0]?.['component']).toBe('routing');
    expect(lines[0]?.['node']).toBe('node-2');
    expect(lines[0]?.['app']).toBe('zvonix');
  });

  it('не повторяет поле component в записи', () => {
    // Проверяется сырой текст, а не разобранный объект: JSON.parse при повторе
    // ключа молча оставляет последний, и дефект остаётся невидимым для теста,
    // хотя в собранных логах запись становится неотличимо испорченной.
    const raw: string[] = [];
    const log = createLogger(
      { level: 'debug', format: 'json', component: 'api', base: { app: 'zvonix' } },
      {
        write(line: string) {
          raw.push(line);
        },
      },
    );

    log.child('operator-resolver').child('lookup').info('запрос');

    const line = raw[0] ?? '';
    expect(line.match(/"component":/g)).toHaveLength(1);
    expect(line).toContain('"component":"lookup"');
  });

  it('внук наследует поля деда', () => {
    const { log, lines } = make();
    log.child('routing', { node: 'node-2' }).child('selection').info('шлюз выбран');
    expect(lines[0]?.['component']).toBe('selection');
    expect(lines[0]?.['node']).toBe('node-2');
    expect(lines[0]?.['app']).toBe('zvonix');
  });
});

describe('маскирование — маскирует логгер, а не автор вызова', () => {
  it('скрывает значения по имени поля', () => {
    const { log, lines } = make();
    log.info('подключение', {
      database_url: 'postgresql://user:ПАРОЛЬ@host/db',
      api_key: 'sk-123',
      password: 'qwerty',
      host: '10.0.0.5',
    });
    const entry = lines[0];
    expect(entry?.['database_url']).toBe('<скрыто>');
    expect(entry?.['api_key']).toBe('<скрыто>');
    expect(entry?.['password']).toBe('<скрыто>');
    expect(entry?.['host']).toBe('10.0.0.5');
    expect(JSON.stringify(entry)).not.toContain('ПАРОЛЬ');
  });

  it('маскирует телефонные номера в любом поле', () => {
    const { log, lines } = make();
    log.info('вызов принят', { msisdn: '+7 913 042-41-23', note: 'абонент 79130424123 занят' });
    const entry = lines[0];
    expect(String(entry?.['msisdn'])).not.toContain('0424123');
    expect(String(entry?.['note'])).not.toContain('79130424123');
  });

  it('маскирует номер в тексте сообщения тоже', () => {
    // Сообщение проходит тот же путь, что и поля: иначе номер утечёт через msg.
    const { log, lines } = make();
    log.error('не дозвонились', new Error('busy: +7 913 042-41-23'));
    expect(JSON.stringify(lines[0])).not.toContain('0424123');
  });

  it('заходит внутрь вложенных структур', () => {
    const { log, lines } = make();
    log.info('маршрут', {
      candidates: [{ alias: 'Синий-14', sim: { msisdn: '+79130424123', token: 't-1' } }],
    });
    const dump = JSON.stringify(lines[0]);
    expect(dump).not.toContain('0424123');
    expect(dump).not.toContain('t-1');
    expect(dump).toContain('Синий-14');
  });

  it('оставляет достаточно, чтобы узнать вызов', () => {
    expect(maskPhone('+7 913 042-41-23')).toBe('7913*****23');
  });

  it('не ломается на самоссылающихся объектах', () => {
    const loop: Record<string, unknown> = { name: 'узел' };
    loop['self'] = loop;
    expect(() => redact(loop)).not.toThrow();
    expect(JSON.stringify(redact(loop))).toContain('циклическая ссылка');
  });

  it('разворачивает ошибку со стеком и причиной', () => {
    const { log, lines } = make();
    log.error('сбой тарификации', new Error('внешняя', { cause: new Error('таймаут') }));
    const error = lines[0]?.['error'] as Record<string, unknown>;
    expect(error['message']).toBe('внешняя');
    expect(typeof error['stack']).toBe('string');
    expect((error['cause'] as Record<string, unknown>)['message']).toBe('таймаут');
  });

  it('переводит BigInt в строку, а не падает', () => {
    // Деньги хранятся в BigInt, и JSON.stringify на нём выбрасывает исключение.
    const { log, lines } = make();
    log.info('списание', { amount_micros: 1_370_000n });
    expect(lines[0]?.['amount_micros']).toBe('1370000');
  });
});
