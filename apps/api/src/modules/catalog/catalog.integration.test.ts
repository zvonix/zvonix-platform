/**
 * Справочник операторов и определение оператора номера на реальной базе (ADR-0013).
 *
 * Внешний сервис здесь выключен намеренно: проверка не должна зависеть ни от сети,
 * ни от чужой доступности. Поведение самого клиента к сервису проверяется отдельно,
 * без сети, в operator-lookup.test.ts.
 */

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

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${adminToken}` });

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
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ к справочнику', () => {
  it('без входа закрыт', async () => {
    expect((await api().inject({ method: 'GET', url: '/operators' })).statusCode).toBe(401);
  });

  it('клиенту открыт: из него он выбирает разрешённых операторов канала', async () => {
    // Роль появилась вместе с разрешёнными операторами канала (ADR-0025): выбирать
    // операторов, не видя справочника, нельзя. Анонимность партнёра это не задевает —
    // оператор связи не партнёр.
    expect((await roleSees('client')).statusCode).toBe(200);
  });

  it('партнёру не разрешён', async () => {
    // Партнёру справочник назначения не нужен: его SIM заводит администратор,
    // а направления вызовов — не его дело.
    expect((await roleSees('partner')).statusCode).toBe(403);
  });
});

/** Ответ справочника пользователю с этой ролью. */
async function roleSees(role: 'client' | 'partner') {
  const email = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Проверка доступа',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });

  return api().inject({
    method: 'GET',
    url: '/operators',
    headers: { authorization: `Bearer ${login.json<{ token: string }>().token}` },
  });
}

describe('операторы', () => {
  it('заводится и находится по собственному названию', async () => {
    // Каноническое написание добавляется синонимом само: иначе оператор
    // не найдётся по названию, под которым его же и завели.
    const name = `МТС ${String(Date.now())}`;
    const created = await createOperator({ name, mnc: '01', inn: '7740000076' });

    const list = await api().inject({ method: 'GET', url: '/operators', headers: auth() });
    const found = list
      .json<{ operators: { id: string; aliases: string[] }[] }>()
      .operators.find((operator) => operator.id === created.id);

    expect(found?.aliases).toContain(name.toLowerCase());
  });

  it('принимает разные написания одного оператора', async () => {
    const suffix = String(Date.now());
    const created = await createOperator({
      name: `Сбербанк-Телеком ${suffix}`,
      aliases: [`ООО "Сбербанк-Телеком ${suffix}"`, `СберМобайл ${suffix}`],
      isMvno: true,
      hostOperatorId: (await createOperator({ name: `Т2 Мобайл ${suffix}`, mnc: '20' })).id,
    });

    const list = await api().inject({ method: 'GET', url: '/operators', headers: auth() });
    const found = list
      .json<{ operators: { id: string; aliases: string[] }[] }>()
      .operators.find((operator) => operator.id === created.id);

    // Организационная форма и кавычки при сопоставлении не значат ничего.
    expect(found?.aliases).toContain(`сбербанк-телеком ${suffix}`);
    expect(found?.aliases).toContain(`сбермобайл ${suffix}`);
  });

  it('не даёт закрепить одно написание за двумя операторами', async () => {
    // Иначе определение становится неоднозначным ровно там, где ошибка стоит
    // реальных денег партнёра.
    const alias = `Общий-${String(Date.now())}`;
    await createOperator({ name: alias });

    const second = await createOperator({ name: `Другой-${String(Date.now())}` });
    const response = await api().inject({
      method: 'POST',
      url: `/operators/${second.id}/aliases`,
      headers: auth(),
      payload: { alias },
    });

    expect(response.statusCode).toBe(409);
  });

  it('требует хозяина сети ровно у виртуального оператора', async () => {
    const withoutHost = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: auth(),
      payload: { name: `MVNO-${String(Date.now())}`, isMvno: true },
    });
    expect(withoutHost.statusCode).toBe(400);

    const host = await createOperator({ name: `Хост-${String(Date.now())}`, mnc: '02' });
    const hostOnNonMvno = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: auth(),
      payload: { name: `Обычный-${String(Date.now())}`, hostOperatorId: host.id },
    });
    expect(hostOnNonMvno.statusCode).toBe(400);
  });

  it('не допускает цепочки виртуальных операторов', async () => {
    // Хозяин хозяина уводит от физической сети, а именно она нужна маршрутизации.
    const suffix = String(Date.now());
    const network = await createOperator({ name: `Сеть-${suffix}`, mnc: '99' });
    const mvno = await createOperator({
      name: `Первый-MVNO-${suffix}`,
      isMvno: true,
      hostOperatorId: network.id,
    });

    const response = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: auth(),
      payload: { name: `Второй-MVNO-${suffix}`, isMvno: true, hostOperatorId: mvno.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it('отвергает ИНН и MNC неверного формата', async () => {
    // ИНН с опечаткой не свяжет записи двух источников плана нумерации, а разведёт их.
    const bad = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: auth(),
      payload: { name: `Плохой-${String(Date.now())}`, inn: '123' },
    });
    expect(bad.statusCode).toBe(400);

    const badMnc = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: auth(),
      payload: { name: `Плохой-MNC-${String(Date.now())}`, mnc: 'абв' },
    });
    expect(badMnc.statusCode).toBe(400);
  });
});

describe('определение оператора номера', () => {
  it('приводит номер к каноническому виду в любом написании', async () => {
    const first = await api().inject({
      method: 'GET',
      url: '/numbers/%2B7%20913%20042-41-23/operator',
      headers: auth(),
    });
    const second = await api().inject({
      method: 'GET',
      url: '/numbers/89130424123/operator',
      headers: auth(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
  });

  it('отвергает то, что не похоже на номер', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/numbers/не-номер/operator',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('неизвестный номер не подтверждён', async () => {
    // Доменное правило: вызов с неподтверждённым оператором не совершается вовсе.
    const response = await api().inject({
      method: 'GET',
      url: '/numbers/79999999999/operator',
      headers: auth(),
    });
    expect(response.json()).toMatchObject({ confirmed: false, serving: null, source: null });
  });

  it('план нумерации даёт владельца диапазона, но НЕ подтверждает оператора', async () => {
    // Для перенесённого номера план нумерации отвечает неверно: он говорит,
    // кому диапазон выделен, а не кто обслуживает номер сейчас.
    const suffix = String(Date.now()).slice(-6);
    const owner = await createOperator({ name: `Владелец-${suffix}`, mnc: '01' });

    await withDatabase(async (execute) => {
      await execute(sql`
        insert into numbering_plan_ranges
          (id, def_code, range_start, range_end, capacity, operator_id, region, source, imported_at)
        values (gen_random_uuid(), '913', 79130300000, 79130499999, 200000,
                ${owner.id}::uuid, 'Красноярский край', 'nic_t', now())
      `);
    });

    const response = await api().inject({
      method: 'GET',
      url: '/numbers/79130424123/operator',
      headers: auth(),
    });

    const body = response.json<{
      range_owner: { id: string } | null;
      serving: unknown;
      confirmed: boolean;
      source: string | null;
      region: string | null;
    }>();

    expect(body.range_owner?.id).toBe(owner.id);
    expect(body.serving).toBeNull();
    expect(body.confirmed).toBe(false);
    expect(body.source).toBe('numbering_plan');
    expect(body.region).toBe('Красноярский край');
  });

  it('подтверждённая запись из своей базы даёт обслуживающего оператора и сеть', async () => {
    const suffix = String(Date.now()).slice(-6);
    const network = await createOperator({ name: `Сеть-${suffix}`, mnc: '20' });
    const mvno = await createOperator({
      name: `Виртуальный-${suffix}`,
      isMvno: true,
      hostOperatorId: network.id,
    });
    const previous = await createOperator({ name: `Прежний-${suffix}`, mnc: '01' });

    await withDatabase(async (execute) => {
      await execute(sql`
        insert into number_resolutions
          (id, msisdn, operator_id, previous_operator_id, region, source, resolved_at, expires_at)
        values (gen_random_uuid(), '79130424124', ${mvno.id}::uuid, ${previous.id}::uuid,
                'Красноярский край', 'lookup', now(), now() + interval '30 days')
      `);
    });

    const response = await api().inject({
      method: 'GET',
      url: '/numbers/79130424124/operator',
      headers: auth(),
    });

    const body = response.json<{
      serving: { id: string };
      network: { id: string };
      previous_operator: { id: string };
      confirmed: boolean;
      source: string;
    }>();

    expect(body.serving.id).toBe(mvno.id);
    // У виртуального оператора своей сети нет: физическая сеть — сеть хозяина.
    expect(body.network.id).toBe(network.id);
    expect(body.previous_operator.id).toBe(previous.id);
    expect(body.confirmed).toBe(true);
    expect(body.source).toBe('lookup');
  });

  it('просроченная запись не считается подтверждением', async () => {
    // Кэш «навсегда» неверен: абонент может перенести номер повторно,
    // а ложная запись означает платный звонок вместо бесплатного.
    const operator = await createOperator({ name: `Просроченный-${String(Date.now()).slice(-6)}` });

    await withDatabase(async (execute) => {
      await execute(sql`
        insert into number_resolutions
          (id, msisdn, operator_id, source, resolved_at, expires_at)
        values (gen_random_uuid(), '79130424125', ${operator.id}::uuid, 'lookup',
                now() - interval '60 days', now() - interval '30 days')
      `);
    });

    const response = await api().inject({
      method: 'GET',
      url: '/numbers/79130424125/operator',
      headers: auth(),
    });
    expect(response.json()).toMatchObject({ confirmed: false, serving: null });
  });

  it('обращение партнёра отменяет запись немедленно', async () => {
    const operator = await createOperator({ name: `Отменяемый-${String(Date.now()).slice(-6)}` });

    await withDatabase(async (execute) => {
      await execute(sql`
        insert into number_resolutions
          (id, msisdn, operator_id, source, resolved_at, expires_at)
        values (gen_random_uuid(), '79130424126', ${operator.id}::uuid, 'lookup',
                now(), now() + interval '30 days')
      `);
    });

    const before = await api().inject({
      method: 'GET',
      url: '/numbers/79130424126/operator',
      headers: auth(),
    });
    expect(before.json()).toMatchObject({ confirmed: true });

    const invalidated = await api().inject({
      method: 'POST',
      url: '/numbers/79130424126/invalidate',
      headers: auth(),
    });
    expect(invalidated.json()).toEqual({ invalidated: true });

    // Срок годности ещё не истёк, но запись уже не действует.
    const after = await api().inject({
      method: 'GET',
      url: '/numbers/79130424126/operator',
      headers: auth(),
    });
    expect(after.json()).toMatchObject({ confirmed: false, serving: null });

    // Повторная отмена ничего не меняет: отменять уже нечего.
    const again = await api().inject({
      method: 'POST',
      url: '/numbers/79130424126/invalidate',
      headers: auth(),
    });
    expect(again.json()).toEqual({ invalidated: false });
  });

  it('считает обращения к номеру для приоритета фонового обновления', async () => {
    const operator = await createOperator({ name: `Считаемый-${String(Date.now()).slice(-6)}` });
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into number_resolutions
          (id, msisdn, operator_id, source, resolved_at, expires_at)
        values (gen_random_uuid(), '79130424127', ${operator.id}::uuid, 'lookup',
                now(), now() + interval '30 days')
      `);
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api().inject({
        method: 'GET',
        url: '/numbers/79130424127/operator',
        headers: auth(),
      });
    }

    const counted = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select use_count from number_resolutions where msisdn = '79130424127'`,
      );
      return (result.rows[0] as { use_count: number }).use_count;
    });
    expect(counted).toBe(3);
  });
});
