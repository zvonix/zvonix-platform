/**
 * Связка резолвера с внешним источником — на реальной базе и реальном HTTP.
 *
 * Источник подменён локальным сервером-заглушкой, а не самим сервисом: заглушка
 * ставится **на границе внешней системы**, что ADR-0006 разрешает прямо. Собственные
 * модули при этом настоящие — резолвер, репозиторий и база работают как в production.
 *
 * Проверяется то, что нельзя проверить ни без базы, ни без HTTP: ответ источника
 * оседает в собственной базе и переиспользуется, а пробел в справочнике операторов
 * не проглатывается, а доносится наверх с названием.
 */

import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';

/** Что заглушка отвечает на очередной запрос. Задаётся каждым тестом под себя. */
let answer: Record<string, string> = {};
let requests: string[] = [];
let stub: Server | undefined;

/** Поднимает заглушку на свободном порту и возвращает её адрес. */
async function startStub(): Promise<string> {
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  stub = server;

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Заглушка не поднялась');
  return `http://127.0.0.1:${String(address.port)}/get/`;
}

const lookupUrl = await startStub();

prepareEnvironment({
  OPERATOR_LOOKUP_ENABLED: 'true',
  OPERATOR_LOOKUP_URL: lookupUrl,
  // Темп максимальный: поведение очереди проверено без сети в operator-lookup.test.ts.
  OPERATOR_LOOKUP_RPS: '10',
});

let app: NestFastifyApplication | undefined;
let token = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

async function createOperator(body: Record<string, unknown>): Promise<{ id: string }> {
  const response = await api().inject({
    method: 'POST',
    url: '/operators',
    headers: auth(),
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ operator: { id: string } }>().operator;
}

async function resolve(msisdn: string) {
  const response = await api().inject({
    method: 'GET',
    url: `/numbers/${msisdn}/operator`,
    headers: auth(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    serving: { name: string } | null;
    previous_operator: { name: string } | null;
    network: { name: string } | null;
    region: string | null;
    source: string | null;
    confirmed: boolean;
    reason: string | null;
  }>();
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  token = login.json<{ token: string }>().token;
}, 90_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => {
    if (stub === undefined) {
      resolve();
      return;
    }
    stub.close(() => {
      resolve();
    });
  });
});

describe('ответ источника попадает в собственную базу', () => {
  it('разрешает номер, сохраняет его и второй раз наружу не ходит', async () => {
    // Ради этого свойства всё и строится: внешний сервис не источник истины
    // в рантайме, а способ наполнить собственную базу.
    const suffix = String(Date.now()).slice(-6);
    const network = await createOperator({ name: `Сеть-${suffix}`, mnc: '20' });
    await createOperator({ name: `Прежний-${suffix}`, mnc: '01' });
    await createOperator({
      name: `Обслуживающий-${suffix}`,
      isMvno: true,
      hostOperatorId: network.id,
    });

    answer = {
      operator: `Обслуживающий-${suffix}`,
      old_operator: `Прежний-${suffix}`,
      region: 'Красноярский край',
    };
    requests = [];

    const first = await resolve('79130001111');
    expect(first.confirmed).toBe(true);
    expect(first.serving?.name).toBe(`Обслуживающий-${suffix}`);
    expect(first.previous_operator?.name).toBe(`Прежний-${suffix}`);
    // У виртуального оператора своей сети нет: физическая сеть — сеть хозяина.
    expect(first.network?.name).toBe(`Сеть-${suffix}`);
    expect(first.region).toBe('Красноярский край');
    expect(first.source).toBe('lookup');
    expect(requests).toHaveLength(1);

    const second = await resolve('79130001111');
    expect(second.confirmed).toBe(true);
    expect(second.serving?.name).toBe(`Обслуживающий-${suffix}`);
    // Второго обращения наружу не было — ответ взят из своей базы.
    expect(requests).toHaveLength(1);
  });

  it('передаёт источнику номер в каноническом виде, как бы его ни записали', async () => {
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Канонический-${suffix}` });
    answer = { operator: `Канонический-${suffix}` };
    requests = [];

    await resolve('%2B7%20913%20000-22-22');
    expect(requests[0]).toContain('num=79130002222');
  });
});

describe('пробел в справочнике не проглатывается', () => {
  it('незнакомый обслуживающий оператор: отказ с названием', async () => {
    // Иначе пробел справочника выглядит как «номер не определяется»
    // и разбирается чтением логов.
    answer = { operator: 'Оператор Которого Нет В Справочнике' };
    const resolution = await resolve('79130003333');

    expect(resolution.confirmed).toBe(false);
    expect(resolution.serving).toBeNull();
    expect(resolution.reason).toBe('operator_not_in_catalog');
  });

  it('незнакомый прежний оператор не отменяет разрешения', async () => {
    // Обслуживающий известен — вызов возможен. Но факт переноса записан не будет,
    // и это должно быть видно, а не потеряться.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Известный-${suffix}`, mnc: '02' });

    answer = { operator: `Известный-${suffix}`, old_operator: 'Неизвестный прежний' };
    const resolution = await resolve('79130004444');

    expect(resolution.confirmed).toBe(true);
    expect(resolution.serving?.name).toBe(`Известный-${suffix}`);
    expect(resolution.previous_operator).toBeNull();

    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select previous_operator_id from number_resolutions where msisdn = '79130004444'`,
      );
      return (result.rows[0] as { previous_operator_id: string | null }).previous_operator_id;
    });
    expect(stored).toBeNull();
  });

  it('источник не знает номера — оператор не подтверждён', async () => {
    answer = { operator: '' };
    const resolution = await resolve('79130005555');
    expect(resolution.confirmed).toBe(false);
    expect(resolution.reason).toBe('unknown_number');
  });
});

describe('устойчивость к поведению источника', () => {
  it('находит оператора по любому написанию названия', async () => {
    // Источник отвечает «Сбербанк-Телеком», файл пишет «ООО "Сбербанк-Телеком"»,
    // люди говорят «СберМобайл» — это один оператор.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({
      name: `Многоимённый-${suffix}`,
      aliases: [`ООО "Многоимённый-${suffix}"`],
    });

    answer = { operator: `ООО «МНОГОИМЁННЫЙ-${suffix}»` };
    const resolution = await resolve('79130006666');

    expect(resolution.confirmed).toBe(true);
    expect(resolution.serving?.name).toBe(`Многоимённый-${suffix}`);
  });

  it('прежний оператор, совпавший с текущим, отбрасывается', async () => {
    // Такая пара — признак ошибки разбора ответа, и база её всё равно не примет.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Одинаковый-${suffix}` });

    answer = { operator: `Одинаковый-${suffix}`, old_operator: `Одинаковый-${suffix}` };
    const resolution = await resolve('79130007777');

    expect(resolution.confirmed).toBe(true);
    expect(resolution.previous_operator).toBeNull();
  });
});

/** Свой номер у каждой проверки: записи живут в общей базе до конца файла. */
let numbers = 0;
const nextMsisdn = (): string => {
  numbers += 1;
  return `7913900${String(numbers).padStart(4, '0')}`;
};

describe('фоновое обновление просроченных записей', () => {
  /** Служба резолвера напрямую: проход фоновой, обработчика у него нет. */
  async function resolver() {
    const { OperatorResolverService } = await import('./operator-resolver.service.js');
    return api().get(OperatorResolverService);
  }

  async function storedRow(msisdn: string) {
    return withDatabase(async (execute) => {
      const result = await execute(
        sql`select use_count, invalidated_at, expires_at > now() as live
              from number_resolutions where msisdn = ${msisdn}`,
      );
      return result.rows[0] as
        { use_count: number; invalidated_at: string | null; live: boolean } | undefined;
    });
  }

  /**
   * Делает запись просроченной.
   *
   * Отодвигается и момент разрешения: база требует, чтобы срок годности был позже него
   * (`number_resolutions_ttl`), и одна лишь просроченная отметка — состояние, которого
   * не бывает. Здесь запись выглядит как разрешённая сорок дней назад при месячном сроке.
   */
  async function expire(msisdn: string): Promise<void> {
    await withDatabase(async (execute) => {
      await execute(
        sql`update number_resolutions
               set resolved_at = now() - interval '40 days',
                   expires_at = now() - interval '10 days'
             where msisdn = ${msisdn}`,
      );
    });
  }

  it('продлевает просроченную запись, не считая это обращением', async () => {
    // Счётчик востребованности сам же и выбирает номера для обновления: расти
    // от собственной работы он не должен, иначе порядок перестаёт что-то значить.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Обновляемый-${suffix}` });

    const msisdn = nextMsisdn();
    answer = { operator: `Обновляемый-${suffix}`, region: 'Москва' };
    expect((await resolve(msisdn)).confirmed).toBe(true);

    const before = await storedRow(msisdn);
    expect(before?.live).toBe(true);
    await expire(msisdn);

    expect(await (await resolver()).refreshStale(new Date())).toBeGreaterThan(0);

    const after = await storedRow(msisdn);
    expect(after?.live).toBe(true);
    expect(after?.use_count).toBe(before?.use_count);
  }, 120_000);

  it('снимает отметку об ошибке определения', async () => {
    // Отменённая обращением партнёра запись обновляется наравне с просроченной:
    // иначе номер остаётся неопределимым до следующего звонка по нему.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Отменяемый-${suffix}` });

    const msisdn = nextMsisdn();
    answer = { operator: `Отменяемый-${suffix}`, region: 'Москва' };
    await resolve(msisdn);

    const invalidated = await api().inject({
      method: 'POST',
      url: `/numbers/${msisdn}/invalidate`,
      headers: auth(),
    });
    expect(invalidated.statusCode).toBe(200);
    expect((await storedRow(msisdn))?.invalidated_at).not.toBeNull();

    await (await resolver()).refreshStale(new Date());
    expect((await storedRow(msisdn))?.invalidated_at).toBeNull();
  }, 120_000);

  it('молчание источника оставляет запись просроченной', async () => {
    // Следующий проход попробует снова. Затирать известное неизвестным нельзя:
    // недоступность источника не факт о номере.
    const suffix = String(Date.now()).slice(-6);
    await createOperator({ name: `Молчаливый-${suffix}` });

    const msisdn = nextMsisdn();
    answer = { operator: `Молчаливый-${suffix}`, region: 'Москва' };
    await resolve(msisdn);
    await expire(msisdn);

    // Источник отвечает пустым: номер он не знает.
    answer = {};
    expect(await (await resolver()).refreshStale(new Date())).toBe(0);
    expect((await storedRow(msisdn))?.live).toBe(false);
  }, 120_000);

  it('нечего обновлять — прохода нет', async () => {
    const service = await resolver();
    await service.refreshStale(new Date());
    expect(await service.refreshStale(new Date())).toBe(0);
  }, 120_000);
});
