/**
 * Загрузка плана нумерации на реальной базе и реальном HTTP (ADR-0032).
 *
 * Источник подменён локальным сервером-заглушкой — заглушка на границе внешней системы,
 * что ADR-0006 разрешает прямо. Всё остальное настоящее: разбор, сопоставление
 * операторов, замена плана целиком и резолвер поверх него.
 *
 * Проверяется главное, чего не видно ни без базы, ни без HTTP: импорт заводит операторов
 * **непроверенными** и потому ничего не разрешает, негодная выгрузка не стирает уже
 * загруженный план, а повторная загрузка не удваивает справочник.
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

const HEADER = 'АВС/ DEF;От;До;Емкость;Оператор;Регион;Территория ГАР;ИНН';

/** Два написания одного юридического лица — ровно то, ради чего слияние идёт по ИНН. */
const FIRST = { spellings: ['ООО "Т2 МОБАЙЛ"', 'Теле2'], inn: '7743895280' };
const SECOND = { spellings: ['ПАО "МТС"'], inn: '7740000076' };

/**
 * Правдоподобная выгрузка: пороги проверки — 10 000 диапазонов и 50 DEF-кодов,
 * и набор обязан их перешагнуть, иначе проверялась бы отмена замены, а не замена.
 */
function plausibleFile(): string {
  const rows: string[] = [];
  for (let def = 900; def < 960; def += 1) {
    for (let block = 0; block < 170; block += 1) {
      const from = String(block * 1000).padStart(7, '0');
      const to = String(block * 1000 + 999).padStart(7, '0');
      const owner = block % 2 === 0 ? FIRST : SECOND;
      // Чередование по номеру блока внутри своего оператора: `block % 2` уже занято
      // выбором оператора, и второе написание при нём не встретилось бы никогда.
      const spelling = owner.spellings[Math.floor(block / 2) % owner.spellings.length] ?? '';
      rows.push(
        `${String(def)};${from};${to};1000;${spelling};-;Регион ${String(def)};${owner.inn}`,
      );
    }
  }
  return [HEADER, ...rows].join('\n');
}

const PLAN = plausibleFile();
const PLAN_RANGES = PLAN.split('\n').length - 1;

/** Что заглушка отдаёт на очередной запрос. Меняется тестами под себя. */
let served = PLAN;
const userAgents: string[] = [];
let stub: Server | undefined;

async function startStub(): Promise<string> {
  const server = createServer((request, response) => {
    userAgents.push(request.headers['user-agent'] ?? '');
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
    response.end(served);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  stub = server;

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Заглушка не поднялась');
  return `http://127.0.0.1:${String(address.port)}/DEF-9xx.csv`;
}

const planUrl = await startStub();

prepareEnvironment({ NUMBERING_PLAN_ENABLED: 'true', NUMBERING_PLAN_URL: planUrl });

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${adminToken}` });

async function plan() {
  const { NumberingPlanService } = await import('./numbering-plan.service.js');
  return api().get(NumberingPlanService);
}

async function countRanges(): Promise<number> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select count(*)::int as count from numbering_plan_ranges`);
    return (result.rows[0] as { count: number }).count;
  });
}

async function operatorRows(): Promise<{ id: string; name: string; verified_at: string | null }[]> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select id, name, verified_at from operators order by name`);
    return result.rows as { id: string; name: string; verified_at: string | null }[];
  });
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
  adminToken = login.json<{ token: string }>().token;

  const loaded = await (await plan()).load(new Date());
  expect(loaded?.ranges).toBe(PLAN_RANGES);
}, 180_000);

afterAll(async () => {
  await app?.close();
  stub?.close();
});

describe('загрузка', () => {
  it('источнику отправляется честный User-Agent', () => {
    // Источник отвечает 403 на запрос без него и на `curl/*` (проверено 2026-09-03),
    // но принимает название платформы. Подделывать браузер не нужно.
    expect(userAgents[0]).toMatch(/^zvonix\/1\.0 \(\+http/u);
  });

  it('диапазоны легли в базу целиком', async () => {
    expect(await countRanges()).toBe(PLAN_RANGES);
  });

  it('операторы заведены непроверенными', async () => {
    // Файл не говорит, виртуальный оператор или нет: `is_mvno = false` в проверенной
    // записи означало бы утверждение «своя сеть», которого никто не делал.
    const rows = await operatorRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verified_at === null)).toBe(true);
  });

  it('одно юрлицо под двумя написаниями — один оператор и два синонима', async () => {
    // Слияние идёт по ИНН: сравнение названий строками завело бы трёх операторов
    // вместо одного, и определение терялось бы на каждом (ADR-0013).
    const aliases = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select a.alias from operator_aliases a
            join operators o on o.id = a.operator_id
            where o.inn = ${FIRST.inn} order by a.alias`,
      );
      return result.rows.map((row) => (row as { alias: string }).alias);
    });
    expect(aliases).toHaveLength(FIRST.spellings.length);
  });

  it('повторная загрузка не удваивает ни диапазоны, ни справочник', async () => {
    // Задача идёт ежедневно, и «догоняющая» означает, что повтор безвреден (ADR-0020).
    await (await plan()).load(new Date());

    expect(await countRanges()).toBe(PLAN_RANGES);
    expect(await operatorRows()).toHaveLength(2);
  });
});

describe('обновление по сроку', () => {
  it('время последней загрузки — дата, а не строка драйвера', async () => {
    // Регрессия 2026-09-30: агрегат приходил строкой, `refresh` падал на `.getTime()`, и план
    // нумерации на боевом сервере не обновлялся вовсе.
    const { CatalogRepository } = await import('./catalog.repository.js');
    const last = await api().get(CatalogRepository).lastPlanImportAt('mincifry');
    expect(last).toBeInstanceOf(Date);
  });

  it('свежий план не качается заново и проход не падает', async () => {
    expect(await (await plan()).refresh(new Date())).toBe(0);
  });
});

describe('негодная выгрузка', () => {
  it('не стирает уже загруженный план', async () => {
    // Источник отдаёт страницу с ошибкой тем же кодом 200. Замена целиком необратима:
    // «сначала стереть, потом заметить» здесь означает сутки без плана нумерации.
    const before = await countRanges();
    served = [HEADER, 'ой, всё'].join('\n');

    expect(await (await plan()).load(new Date())).toBeUndefined();
    expect(await countRanges()).toBe(before);
  });

  it('страница с ошибкой тоже не стирает', async () => {
    const before = await countRanges();
    served = '<html><body>503 Service Unavailable</body></html>';

    expect(await (await plan()).load(new Date())).toBeUndefined();
    expect(await countRanges()).toBe(before);

    served = PLAN;
  });
});

describe('определение оператора по плану', () => {
  it('владелец диапазона известен, но вызов не разрешён', async () => {
    // План говорит, кому диапазон ВЫДЕЛЕН, а не кто обслуживает номер сейчас:
    // для перенесённого номера это неверный ответ (ADR-0013).
    const response = await api().inject({
      method: 'GET',
      url: '/numbers/79000000500/operator',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      range_owner: { name: string } | null;
      region: string | null;
      confirmed: boolean;
      source: string | null;
    }>();
    expect(body.range_owner?.name).toBe(FIRST.spellings[0]);
    expect(body.region).toBe('Регион 900');
    expect(body.confirmed).toBe(false);
    expect(body.source).toBe('numbering_plan');
  });
  it('непроверенный оператор вызову не мешает', async () => {
    // `is_mvno = false` — не утверждение «своя сеть», а отказ от утверждения: при нём
    // маршрутизация требует SIM ровно этого оператора и ошибиться в опасную сторону
    // не может ([ADR-0035](../../../../../docs/adr/0035-operator-vladeet-svoey-setyu.md)).
    // Прежнее правило запрещало вызовы по факту, которого маршрутизация не спрашивает,
    // и после импорта звонить было нельзя никуда.
    const msisdn = '79000001500';
    await storeResolution(msisdn, FIRST.inn);

    expect((await operatorRows()).every((row) => row.verified_at === null)).toBe(true);

    const body = await resolve(msisdn);
    expect(body.confirmed).toBe(true);
    expect(body.network?.name).toBe(FIRST.spellings[0]);
  });

  it('подтверждение записи ничего не открывает и не закрывает', async () => {
    // Отметка о проверке — признак «человек это смотрел», а не разрешение (ADR-0035).
    const msisdn = '79000002500';
    await storeResolution(msisdn, SECOND.inn);

    expect((await resolve(msisdn)).confirmed).toBe(true);

    const operator = await withDatabase(async (execute) => {
      const result = await execute(sql`select id from operators where inn = ${SECOND.inn}`);
      return (result.rows[0] as { id: string }).id;
    });

    const verified = await api().inject({
      method: 'POST',
      url: `/operators/${operator}/verify`,
      headers: auth(),
      payload: { isMvno: false, mnc: '01' },
    });
    expect(verified.statusCode).toBe(201);
    expect(
      verified.json<{ operator: { verified_at: string | null } }>().operator.verified_at,
    ).not.toBeNull();

    const after = await resolve(msisdn);
    expect(after.confirmed).toBe(true);
    expect(after.network?.name).toBe(SECOND.spellings[0]);
  });

  it('хозяином сети можно назначить только проверенную запись', async () => {
    // Единственное место, где отметка ещё что-то запрещает: объявление MVNO
    // **расширяет** множество допустимых SIM, и это то самое утверждение,
    // которое должен делать человек (ADR-0035).
    const rows = await operatorRows();
    const unverified = rows.find((row) => row.verified_at === null);
    const target = rows.find((row) => row.id !== unverified?.id);

    const response = await api().inject({
      method: 'POST',
      url: `/operators/${target?.id ?? ''}/verify`,
      headers: auth(),
      payload: { isMvno: true, hostOperatorId: unverified?.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it('подтверждать запись может только администратор', async () => {
    const operator = (await operatorRows())[0]?.id ?? '';
    const response = await api().inject({
      method: 'POST',
      url: `/operators/${operator}/verify`,
      payload: { isMvno: false },
    });
    expect(response.statusCode).toBe(401);
  });
});

/** Кладёт в собственную базу запись «номер обслуживает этот оператор». */
async function storeResolution(msisdn: string, inn: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(
      sql`insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at, created_at, updated_at)
          select gen_random_uuid(), ${msisdn}, o.id, 'lookup', now(), now() + interval '30 days', now(), now()
          from operators o where o.inn = ${inn}`,
    );
  });
}

async function resolve(msisdn: string) {
  const response = await api().inject({
    method: 'GET',
    url: `/numbers/${msisdn}/operator`,
    headers: auth(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    confirmed: boolean;
    reason: string | null;
    network: { name: string } | null;
  }>();
}
