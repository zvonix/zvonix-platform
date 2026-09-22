/**
 * Список клиентов и движение по счёту — `GET /clients` и `GET /clients/:id/entries`.
 *
 * Проверяется то, ради чего они переписаны: остаток приходит вместе со списком
 * (а не запросом на каждого клиента), и у каждой проводки видно, **что произошло**,
 * а не только сумма.
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
let adminAuth: Record<string, string> = {};
let clientAuth: Record<string, string> = {};

/** Общая метка набора: чужие клиенты в отбор попадать не должны. */
const MARK = `М${String(Date.now()).slice(-7)}`;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface ClientView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly overdraft_limit: string;
  readonly balance: string;
  readonly created_at: string;
}

interface EntryView {
  readonly seq: string;
  readonly transaction_id: string;
  readonly amount: string;
  readonly kind: string;
  readonly description: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly created_at: string;
}

async function account(role: 'admin' | 'client'): Promise<Record<string, string>> {
  const email = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Иван Петров',
    role,
    status: 'active',
  });

  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

/** Заводит клиента и возвращает его идентификатор. */
async function createClient(name: string): Promise<string> {
  const ownerEmail = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  const owner = await api().get(IdentityService).createByAdmin({
    email: ownerEmail,
    password: TEST_PASSWORD,
    fullName: 'Владелец службы',
    role: 'client',
    status: 'active',
  });

  const response = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: adminAuth,
    payload: { ownerUserId: owner.id, name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ client: ClientView }>().client.id;
}

async function deposit(clientId: string, amount: string, key: string): Promise<void> {
  const response = await api().inject({
    method: 'POST',
    url: `/clients/${clientId}/deposit`,
    headers: adminAuth,
    payload: { amount, idempotencyKey: key, description: 'Пополнение по счёту' },
  });
  expect(response.statusCode).toBe(200);
}

async function list(query: string): Promise<{ clients: ClientView[]; total: number }> {
  const response = await api().inject({
    method: 'GET',
    url: `/clients?${query}`,
    headers: adminAuth,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

let firstId = '';
let emptyId = '';

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  adminAuth = await account('admin');
  clientAuth = await account('client');

  firstId = await createClient(`${MARK} Такси Первое`);
  await createClient(`${MARK} Такси Второе`);
  emptyId = await createClient(`${MARK} Такси Без Денег`);

  await deposit(firstId, '1500.50', `проверка-${MARK}-1`);
  await deposit(firstId, '499.50', `проверка-${MARK}-2`);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ', () => {
  it('клиенту чужой список закрыт', async () => {
    const response = await api().inject({ method: 'GET', url: '/clients', headers: clientAuth });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});

describe('список клиентов', () => {
  it('отдаёт остаток вместе со списком', async () => {
    const found = await list(`name=${MARK}`);
    const first = found.clients.find((row) => row.id === firstId);
    expect(first?.balance).toBe('2000');
  }, 120_000);

  it('клиент без единой проводки виден с нулём, а не пропадает', async () => {
    // Соединение со счётом внешнее: у только что заведённого клиента счёт может быть
    // пустым, и внутреннее соединение выбросило бы его из списка молча.
    const found = await list(`name=${MARK}`);
    const empty = found.clients.find((row) => row.id === emptyId);
    expect(empty).toBeDefined();
    expect(empty?.balance).toBe('0');
  }, 120_000);

  it('клиент вообще без счёта тоже виден', async () => {
    // Счёт заводится вместе с клиентом, но строка без него возможна: миграция,
    // ручная правка, будущий путь заведения. Список обязан её показать.
    const orphan = await createClient(`${MARK} Такси Без Счёта`);
    await withDatabase(async (execute) => {
      await execute(sql`delete from accounts where kind = 'client' and owner_id = ${orphan}`);
    });

    const found = await list(`name=${MARK}`);
    expect(found.clients.find((row) => row.id === orphan)?.balance).toBe('0');
  }, 120_000);

  it('ищет по части названия, не различая регистра', async () => {
    const found = await list('name=такси%20первое');
    expect(found.total).toBe(1);
  }, 120_000);

  it('знаки шаблона в поиске ничего не значат', async () => {
    const found = await list('name=%25');
    expect(found.total).toBe(0);
  }, 120_000);

  it('отбирает по состоянию', async () => {
    const pending = await list(`name=${MARK}&status=pending`);
    const active = await list(`name=${MARK}&status=active`);
    expect(pending.total).toBeGreaterThan(0);
    expect(active.total).toBe(0);
  }, 120_000);

  it('негодное состояние — отказ, а не молчаливый полный список', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/clients?status=НЕТ_ТАКОГО',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('размер страницы ограничивает выборку, но не счёт', async () => {
    const page = await list(`name=${MARK}&limit=2`);
    expect(page.clients).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
  }, 120_000);
});

describe('движение по счёту', () => {
  it('у каждой проводки видно, что произошло', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/clients/${firstId}/entries`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ entries: EntryView[]; balance: string; total: number }>();
    expect(body.balance).toBe('2000');
    expect(body.total).toBe(2);

    const entry = body.entries[0];
    expect(entry?.kind).toBe('deposit');
    expect(entry?.description).toBe('Пополнение по счёту');
    expect(entry?.amount).toBe('499.5');
  }, 120_000);

  it('свежее сверху', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/clients/${firstId}/entries`,
      headers: adminAuth,
    });
    const entries = response.json<{ entries: EntryView[] }>().entries;
    const numbers = entries.map((row) => Number(row.seq));
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);
  }, 120_000);

  it('страницы не пересекаются, а счёт остаётся полным', async () => {
    const first = await api().inject({
      method: 'GET',
      url: `/clients/${firstId}/entries?limit=1&offset=0`,
      headers: adminAuth,
    });
    const second = await api().inject({
      method: 'GET',
      url: `/clients/${firstId}/entries?limit=1&offset=1`,
      headers: adminAuth,
    });

    const a = first.json<{ entries: EntryView[]; total: number }>();
    const b = second.json<{ entries: EntryView[]; total: number }>();
    expect(a.total).toBe(2);
    expect(b.total).toBe(2);
    expect(a.entries[0]?.seq).not.toBe(b.entries[0]?.seq);
  }, 120_000);

  it('у клиента без проводок список пуст, а не отказ', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/clients/${emptyId}/entries`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ entries: EntryView[]; total: number }>().total).toBe(0);
  }, 120_000);
});

describe('пополнение', () => {
  it('повтор с тем же ключом денег не добавляет', async () => {
    // Идемпотентность здесь не удобство, а инвариант: повторная отправка формы
    // не должна удваивать деньги.
    const target = await createClient(`${MARK} Такси Повтор`);
    const key = `повтор-${MARK}`;

    await deposit(target, '100', key);
    const again = await api().inject({
      method: 'POST',
      url: `/clients/${target}/deposit`,
      headers: adminAuth,
      payload: { amount: '100', idempotencyKey: key, description: 'Пополнение по счёту' },
    });

    expect(again.statusCode).toBe(200);
    const body = again.json<{ already_posted: boolean; balance: string }>();
    expect(body.already_posted).toBe(true);
    expect(body.balance).toBe('100');
  }, 120_000);
});

describe('смена состояния клиента', () => {
  async function setStatus(id: string, status: string): Promise<number> {
    const response = await api().inject({
      method: 'PATCH',
      url: `/clients/${id}/status`,
      headers: adminAuth,
      payload: { status },
    });
    return response.statusCode;
  }

  it('переводит в active — и клиент становится маршрутизируемым', async () => {
    // Следствие важнее самого перехода: маршрутизация требует `active`
    // и от канала, и от самого клиента, и без этого обработчика заведённый клиент
    // не мог совершить ни одного вызова.
    const target = await createClient(`${MARK} Такси Годное`);
    expect(await setStatus(target, 'active')).toBe(200);

    const found = await list(`name=${MARK}&status=active`);
    expect(found.clients.map((row) => row.id)).toContain(target);
  }, 120_000);

  it('пишет в журнал то, что было до, и то, что стало', async () => {
    const target = await createClient(`${MARK} Такси Журнальное`);
    expect(await setStatus(target, 'active')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=client.status_changed&entityId=${target}`,
      headers: adminAuth,
    });
    const entries = response.json<{ entries: { before: unknown; after: unknown }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.before).toEqual({ status: 'pending' });
    expect(entries[0]?.after).toEqual({ status: 'active' });
  }, 120_000);

  it('повтор того же состояния журнал не засоряет', async () => {
    const target = await createClient(`${MARK} Такси Повторное`);
    expect(await setStatus(target, 'active')).toBe(200);
    expect(await setStatus(target, 'active')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=client.status_changed&entityId=${target}`,
      headers: adminAuth,
    });
    expect(response.json<{ total: number }>().total).toBe(1);
  }, 120_000);

  it('закрытый клиент обратно не открывается', async () => {
    const target = await createClient(`${MARK} Такси Закрытое`);
    expect(await setStatus(target, 'closed')).toBe(200);
    expect(await setStatus(target, 'active')).toBe(409);
  }, 120_000);

  it('несуществующий клиент — 404, негодное состояние — 400', async () => {
    expect(await setStatus('01890a5d-ac96-774b-bcce-b302099a8057', 'active')).toBe(404);
    expect(await setStatus(firstId, 'НЕТ_ТАКОГО')).toBe(400);
  }, 120_000);

  it('клиент чужое состояние не меняет', async () => {
    const response = await api().inject({
      method: 'PATCH',
      url: `/clients/${firstId}/status`,
      headers: clientAuth,
      payload: { status: 'active' },
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});

describe('заведение клиента', () => {
  it('один владелец — один клиент', async () => {
    // Та же причина, что и у партнёра: `findClientOwnedBy` берёт первую попавшуюся
    // строку, и второй клиент у того же человека оказался бы для него недоступен —
    // он не увидел бы ни своих каналов, ни своих записей разговоров.
    const { IdentityService } = await import('../identity/identity.service.js');
    const owner = await api().get(IdentityService).createByAdmin({
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      fullName: 'Владелец службы',
      role: 'client',
      status: 'active',
    });

    const first = await api().inject({
      method: 'POST',
      url: '/clients',
      headers: adminAuth,
      payload: { ownerUserId: owner.id, name: `${MARK} Такси Первое Своё` },
    });
    expect(first.statusCode).toBe(201);

    const second = await api().inject({
      method: 'POST',
      url: '/clients',
      headers: adminAuth,
      payload: { ownerUserId: owner.id, name: `${MARK} Такси Второе Своё` },
    });
    expect(second.statusCode).toBe(409);
  }, 120_000);
});

describe('разрешённый минус', () => {
  async function setOverdraft(id: string, value: string): Promise<number> {
    const response = await api().inject({
      method: 'PATCH',
      url: `/clients/${id}/overdraft`,
      headers: adminAuth,
      payload: { overdraftLimit: value },
    });
    return response.statusCode;
  }

  it('меняется после заведения', async () => {
    // До появления обработчика задавался только при заведении: опечатка в разрядах
    // означала кредит, который нечем отозвать.
    const target = await createClient(`${MARK} Такси Кредитное`);
    expect(await setOverdraft(target, '2500.75')).toBe(200);

    const found = await list(`name=${MARK}%20такси%20кредитное`);
    expect(found.clients[0]?.overdraft_limit).toBe('2500.75');
  }, 120_000);

  it('правка попадает в журнал вместе с прежним значением', async () => {
    const target = await createClient(`${MARK} Такси Журнальный Минус`);
    expect(await setOverdraft(target, '1000')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=client.overdraft_changed&entityId=${target}`,
      headers: adminAuth,
    });
    const entries = response.json<{ entries: { before: unknown; after: unknown }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.before).toEqual({ overdraft_limit: '0' });
    expect(entries[0]?.after).toEqual({ overdraft_limit: '1000' });
  }, 120_000);

  it('то же значение журнал не засоряет', async () => {
    const target = await createClient(`${MARK} Такси Повтор Минуса`);
    expect(await setOverdraft(target, '500')).toBe(200);
    expect(await setOverdraft(target, '500')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=client.overdraft_changed&entityId=${target}`,
      headers: adminAuth,
    });
    expect(response.json<{ total: number }>().total).toBe(1);
  }, 120_000);

  it('не сумма — отказ, а не молчаливый ноль', async () => {
    // Молча подставить ноль на экране денег опаснее, чем отказать: администратор
    // решил бы, что кредит выдан.
    expect(await setOverdraft(firstId, 'много')).toBe(400);
    expect(await setOverdraft(firstId, '')).toBe(400);
  }, 120_000);

  it('клиент свой минус не поднимает', async () => {
    const response = await api().inject({
      method: 'PATCH',
      url: `/clients/${firstId}/overdraft`,
      headers: clientAuth,
      payload: { overdraftLimit: '999999' },
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});
