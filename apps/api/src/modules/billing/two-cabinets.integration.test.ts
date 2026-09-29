/**
 * Один вход — два кабинета ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Кабинет открывает владение карточкой клиента или партнёра, а не роль. Проверяется
 * на настоящей базе: решение принимает защитник по ответу базы о владельце, и подставной
 * репозиторий проверял бы моё представление о запросе, а не сам запрос.
 */

import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { UserRole } from '@zvonix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let admin: Record<string, string> = {};

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

/** Учётная запись с открытым входом и её заголовок авторизации. */
async function person(role: UserRole): Promise<{ id: string; auth: Record<string, string> }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Проверка кабинетов',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return {
    id: created.id,
    auth: { authorization: `Bearer ${login.json<{ token: string }>().token}` },
  };
}

async function createClient(ownerUserId: string) {
  return api().inject({
    method: 'POST',
    url: '/clients',
    headers: admin,
    payload: { ownerUserId, name: unique('Такси') },
  });
}

async function createPartner(ownerUserId: string, displayName = unique('Партнёр')) {
  return api().inject({
    method: 'POST',
    url: '/partners',
    headers: admin,
    payload: { ownerUserId, name: 'Иванов Иван', displayName },
  });
}

async function get(url: string, headers: Record<string, string>) {
  return api().inject({ method: 'GET', url, headers });
}

interface CabinetsBody {
  cabinets: {
    client: { id: string; name: string; status: string } | null;
    partner: { id: string; display_name: string | null; status: string } | null;
  };
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  admin = (await person('admin')).auth;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('кабинеты участника', () => {
  it('владелец обеих карточек входит в оба кабинета тем же входом', async () => {
    const member = await person('member');
    const client = (await createClient(member.id)).json<{ client: { id: string } }>().client.id;
    const displayName = unique('Партнёр');
    const partner = (await createPartner(member.id, displayName)).json<{
      partner: { id: string };
    }>().partner.id;

    const cabinets = (await get('/me/cabinets', member.auth)).json<CabinetsBody>().cabinets;
    expect(cabinets.client?.id).toBe(client);
    expect(cabinets.partner).toMatchObject({ id: partner, display_name: displayName });

    // Балансы раздельные: у каждой карточки свой счёт.
    expect((await get('/client/account', member.auth)).statusCode).toBe(200);
    expect((await get('/partner/account', member.auth)).statusCode).toBe(200);
  }, 120_000);

  it('участнику без карточек кабинеты пусты, а собственный контур закрыт с причиной', async () => {
    const member = await person('member');

    const cabinets = (await get('/me/cabinets', member.auth)).json<CabinetsBody>().cabinets;
    // Без кабинетов заявка на первый открыта всегда — настройка касается второго.
    expect(cabinets).toEqual({ client: null, partner: null, second_cabinet_open: true });

    const response = await get('/partner/account', member.auth);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      'Кабинет партнёра не подключён',
    );
  });

  it('одна карточка открывает только свой кабинет', async () => {
    const member = await person('member');
    expect((await createClient(member.id)).statusCode).toBe(201);

    expect((await get('/client/account', member.auth)).statusCode).toBe(200);
    expect((await get('/partner/account', member.auth)).statusCode).toBe(403);
  });
});

describe('сотрудник площадки', () => {
  it('владельцем карточки не бывает', async () => {
    // Администратор-партнёр сам назначал бы коридоры и цены, по которым получает деньги.
    for (const role of ['admin', 'support'] as const) {
      const staff = await person(role);
      const client = await createClient(staff.id);
      expect(client.statusCode).toBe(409);
      const partner = await createPartner(staff.id);
      expect(partner.statusCode).toBe(409);
    }
  });

  it('кабинетов не имеет и в собственный контур не входит', async () => {
    const cabinets = (await get('/me/cabinets', admin)).json<CabinetsBody>().cabinets;
    expect(cabinets).toEqual({ client: null, partner: null, second_cabinet_open: false });
    expect((await get('/client/account', admin)).statusCode).toBe(403);
  });
});

describe('заведение карточки', () => {
  it('занятый псевдоним не оставляет партнёра без псевдонима', async () => {
    // Раньше партнёр вставлялся отдельным запросом до псевдонима: отказ по занятому
    // имени оставлял карточку без псевдонима, и второй попытке мешало «уже есть партнёр».
    const taken = unique('Партнёр');
    expect((await createPartner((await person('member')).id, taken)).statusCode).toBe(201);

    const member = await person('member');
    expect((await createPartner(member.id, taken)).statusCode).toBe(409);
    expect((await createPartner(member.id)).statusCode).toBe(201);
  });

  it('вторая карточка того же вида тому же владельцу — отказ', async () => {
    const member = await person('member');
    expect((await createClient(member.id)).statusCode).toBe(201);
    expect((await createClient(member.id)).statusCode).toBe(409);
  });

  it('пишется в журнал действий с тем, кто завёл', async () => {
    const member = await person('member');
    const client = (await createClient(member.id)).json<{ client: { id: string } }>().client.id;
    const partner = (await createPartner(member.id)).json<{ partner: { id: string } }>().partner.id;

    const rows = await withDatabase(async (execute) =>
      execute(sql`
        select action, entity_id, actor_role, after
        from audit_log
        where entity_id in (${client}, ${partner})
        order by action
      `),
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        action: 'client.created',
        entity_id: client,
        actor_role: 'admin',
        after: expect.objectContaining({ owner_user_id: member.id, status: 'pending' }) as unknown,
      }),
      expect.objectContaining({
        action: 'partner.created',
        entity_id: partner,
        actor_role: 'admin',
        after: expect.objectContaining({ owner_user_id: member.id, status: 'pending' }) as unknown,
      }),
    ]);
  });
});
