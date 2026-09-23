/**
 * Партнёры в административном контуре — `GET /partners`,
 * `PATCH /partners/:id/status`, `GET /partners/:id/entries`.
 *
 * Главное здесь — переход в `verified`. До его появления партнёр, заведённый через API,
 * не мог терминировать ни одного вызова: он создаётся `pending`, а и регистрация шлюза,
 * и отбор SIM требуют `verified`, и **ни одна строка кода это поле не писала**.
 * Поэтому проверяется не только сам обработчик, но и его следствие: партнёр появляется
 * в списке, из которого выбирает клиент.
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

/** Общая метка набора: чужие партнёры в отбор попадать не должны. */
const MARK = `П${String(Date.now()).slice(-7)}`;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface PartnerView {
  readonly id: string;
  readonly name: string;
  readonly display_name: string | null;
  readonly status: string;
  readonly listens_to_recordings: boolean;
  readonly balance: string;
  readonly created_at: string;
}

/**
 * Вход администратора либо клиента. Клиенту заводится карточка: кабинет открывает
 * владение ею, а не роль (ADR-0052), и без неё список псевдонимов ему закрыт.
 */
async function account(kind: 'admin' | 'client'): Promise<Record<string, string>> {
  const email = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  const user = await api()
    .get(IdentityService)
    .createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Иван Петров',
      role: kind === 'admin' ? 'admin' : 'member',
      status: 'active',
    });
  if (kind === 'client') {
    const created = await api().inject({
      method: 'POST',
      url: '/clients',
      headers: adminAuth,
      payload: { ownerUserId: user.id, name: `${MARK} Такси` },
    });
    expect(created.statusCode).toBe(201);
  }

  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

/** Заводит партнёра и возвращает его идентификатор. */
async function createPartner(name: string, displayName: string): Promise<string> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const owner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец шлюза',
    role: 'partner',
    status: 'active',
  });

  const response = await api().inject({
    method: 'POST',
    url: '/partners',
    headers: adminAuth,
    payload: { ownerUserId: owner.id, name, displayName },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ partner: { id: string } }>().partner.id;
}

async function list(query: string): Promise<{ partners: PartnerView[]; total: number }> {
  const response = await api().inject({
    method: 'GET',
    url: `/partners?${query}`,
    headers: adminAuth,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function setStatus(id: string, status: string): Promise<number> {
  const response = await api().inject({
    method: 'PATCH',
    url: `/partners/${id}/status`,
    headers: adminAuth,
    payload: { status },
  });
  return response.statusCode;
}

let firstId = '';

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  adminAuth = await account('admin');
  clientAuth = await account('client');

  firstId = await createPartner(`${MARK} Пётр Терминатов`, `${MARK} Партнёр 1`);
  await createPartner(`${MARK} Мария Шлюзова`, `${MARK} Партнёр 2`);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ', () => {
  it('клиенту административный список закрыт', async () => {
    // Иначе настоящие имена партнёров попали бы в клиентский контур,
    // а ADR-0014 считает это дефектом уровня инварианта.
    const response = await api().inject({ method: 'GET', url: '/partners', headers: clientAuth });
    expect(response.statusCode).toBe(403);
  }, 120_000);

  it('клиент не меняет состояние партнёра', async () => {
    const response = await api().inject({
      method: 'PATCH',
      url: `/partners/${firstId}/status`,
      headers: clientAuth,
      payload: { status: 'verified' },
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});

describe('список партнёров', () => {
  it('отдаёт остаток и псевдоним вместе со списком', async () => {
    const found = await list(`name=${MARK}`);
    const first = found.partners.find((row) => row.id === firstId);
    expect(first?.display_name).toBe(`${MARK} Партнёр 1`);
    expect(first?.balance).toBe('0');
    expect(first?.status).toBe('pending');
  }, 120_000);

  it('ищет по настоящему имени, не различая регистра', async () => {
    const found = await list('name=пётр%20терминатов');
    expect(found.total).toBe(1);
  }, 120_000);

  it('ищет и по псевдониму: администратор помнит одно из двух', async () => {
    const found = await list(`name=${MARK}%20партнёр%202`);
    expect(found.total).toBe(1);
  }, 120_000);

  it('знаки шаблона в поиске ничего не значат', async () => {
    const found = await list('name=%25');
    expect(found.total).toBe(0);
  }, 120_000);

  it('партнёр без псевдонима виден, а не пропадает', async () => {
    // Соединение с псевдонимами внешнее: партнёр без псевдонима — это как раз тот,
    // кого администратору нужно увидеть и починить, а не тот, кого надо спрятать.
    const orphan = await createPartner(`${MARK} Без Псевдонима`, `${MARK} Партнёр 3`);
    await withDatabase(async (execute) => {
      await execute(sql`delete from partner_aliases where partner_id = ${orphan}`);
    });

    const found = await list(`name=${MARK}%20без`);
    expect(found.partners.find((row) => row.id === orphan)?.display_name).toBeNull();
  }, 120_000);

  it('отбирает по состоянию', async () => {
    const pending = await list(`name=${MARK}&status=pending`);
    const verified = await list(`name=${MARK}&status=verified`);
    expect(pending.total).toBeGreaterThan(0);
    expect(verified.total).toBe(0);
  }, 120_000);

  it('негодное состояние — отказ, а не молчаливый полный список', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/partners?status=НЕТ_ТАКОГО',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('размер страницы ограничивает выборку, но не счёт', async () => {
    const page = await list(`name=${MARK}&limit=2`);
    expect(page.partners).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
  }, 120_000);
});

describe('карточка партнёра', () => {
  it('та же строка, что в списке, — с именем, псевдонимом и остатком', async () => {
    const found = await list(`name=${MARK}`);
    const row = found.partners.find((partner) => partner.id === firstId);
    const response = await api().inject({
      method: 'GET',
      url: `/partners/${firstId}`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ partner: PartnerView }>().partner).toEqual(row);
  }, 120_000);

  it('несуществующий — 404, а не пустая карточка', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/partners/01a0cc00-0000-7000-8000-000000000000',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('клиенту закрыта: настоящее имя партнёра в его контур не попадает (ADR-0014)', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/partners/${firstId}`,
      headers: clientAuth,
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});

describe('смена состояния', () => {
  it('переводит в verified — и партнёр становится виден клиенту', async () => {
    // Следствие важнее самого перехода: `verified` — единственное состояние,
    // при котором партнёр вообще участвует в работе площадки.
    const target = await createPartner(`${MARK} Годный`, `${MARK} Партнёр Годный`);

    const before = await api().inject({
      method: 'GET',
      url: '/partner-aliases',
      headers: clientAuth,
    });
    const namesBefore = before
      .json<{ partners: { display_name: string }[] }>()
      .partners.map((row) => row.display_name);
    expect(namesBefore).not.toContain(`${MARK} Партнёр Годный`);

    expect(await setStatus(target, 'verified')).toBe(200);

    const after = await api().inject({
      method: 'GET',
      url: '/partner-aliases',
      headers: clientAuth,
    });
    const namesAfter = after
      .json<{ partners: { display_name: string }[] }>()
      .partners.map((row) => row.display_name);
    expect(namesAfter).toContain(`${MARK} Партнёр Годный`);
  }, 120_000);

  it('пишет в журнал то, что было до, и то, что стало', async () => {
    const target = await createPartner(`${MARK} Журнальный`, `${MARK} Партнёр Журнальный`);
    expect(await setStatus(target, 'verified')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=partner.status_changed&entityId=${target}`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);

    const entries = response.json<{ entries: { before: unknown; after: unknown }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.before).toEqual({ status: 'pending' });
    expect(entries[0]?.after).toEqual({ status: 'verified' });
  }, 120_000);

  it('повтор того же состояния journal не засоряет', async () => {
    const target = await createPartner(`${MARK} Повторный`, `${MARK} Партнёр Повторный`);
    expect(await setStatus(target, 'verified')).toBe(200);
    expect(await setStatus(target, 'verified')).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=partner.status_changed&entityId=${target}`,
      headers: adminAuth,
    });
    expect(response.json<{ total: number }>().total).toBe(1);
  }, 120_000);

  it('закрытый партнёр обратно не открывается', async () => {
    // `closed` терминально: у закрытого остаётся история выплат, и тихое возвращение
    // его в работу — не то, что администратор ожидает от выпадающего списка.
    const target = await createPartner(`${MARK} Закрытый`, `${MARK} Партнёр Закрытый`);
    expect(await setStatus(target, 'closed')).toBe(200);
    expect(await setStatus(target, 'verified')).toBe(409);
  }, 120_000);

  it('несуществующий партнёр — 404', async () => {
    expect(await setStatus('01890a5d-ac96-774b-bcce-b302099a8057', 'verified')).toBe(404);
  }, 120_000);

  it('негодное состояние — 400', async () => {
    expect(await setStatus(firstId, 'НЕТ_ТАКОГО')).toBe(400);
  }, 120_000);
});

describe('движение по счёту партнёра', () => {
  it('у нового партнёра список пуст, а не отказ', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/partners/${firstId}/entries`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ entries: unknown[]; balance: string; total: number }>();
    expect(body.total).toBe(0);
    expect(body.balance).toBe('0');
  }, 120_000);

  it('несуществующий партнёр — 404, а не пустая лента', async () => {
    // Счёт заводится по требованию, и без этой проверки запрос по выдуманному
    // идентификатору отвечал бы «движения нет» вместо «такого партнёра нет».
    const response = await api().inject({
      method: 'GET',
      url: '/partners/01890a5d-ac96-774b-bcce-b302099a8057/entries',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);
});

describe('заведение партнёра', () => {
  it('один владелец — один партнёр', async () => {
    // Схема этого не требует, а код требует: `findPartnerOwnedBy` берёт первую
    // попавшуюся строку, и второй партнёр у того же человека оказался бы для него
    // самого недоступен — он не смог бы объявить по нему намерение слушать записи.
    const { IdentityService } = await import('../identity/identity.service.js');
    const owner = await api().get(IdentityService).createByAdmin({
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      fullName: 'Владелец шлюза',
      role: 'partner',
      status: 'active',
    });

    const first = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: adminAuth,
      payload: { ownerUserId: owner.id, name: `${MARK} Первый`, displayName: `${MARK} Псевдо 1` },
    });
    expect(first.statusCode).toBe(201);

    const second = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: adminAuth,
      payload: { ownerUserId: owner.id, name: `${MARK} Второй`, displayName: `${MARK} Псевдо 2` },
    });
    expect(second.statusCode).toBe(409);
  }, 120_000);

  it('у заведённого партнёра сразу есть счёт', async () => {
    // Партнёр без счёта — участник, которому некуда начислить долю за вызов.
    const created = await createPartner(`${MARK} Со Счётом`, `${MARK} Партнёр Счётный`);
    const response = await api().inject({
      method: 'GET',
      url: `/partners/${created}/entries`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ balance: string }>().balance).toBe('0');
  }, 120_000);
});

describe('переименование псевдонима', () => {
  async function rename(id: string, displayName: string): Promise<number> {
    const response = await api().inject({
      method: 'PUT',
      url: `/partners/${id}/alias`,
      headers: adminAuth,
      payload: { displayName },
    });
    return response.statusCode;
  }

  it('меняется и сразу виден клиенту', async () => {
    // Псевдоним — единственное, что клиент о партнёре знает, и до появления
    // обработчика опечатка в нём оставалась навсегда.
    const target = await createPartner(`${MARK} Переименуемый`, `${MARK} Псевдо Старый`);
    expect(await setStatus(target, 'verified')).toBe(200);
    expect(await rename(target, `${MARK} Псевдо Новый`)).toBe(200);

    const seen = await api().inject({
      method: 'GET',
      url: '/partner-aliases',
      headers: clientAuth,
    });
    const names = seen
      .json<{ partners: { display_name: string }[] }>()
      .partners.map((row) => row.display_name);
    expect(names).toContain(`${MARK} Псевдо Новый`);
    expect(names).not.toContain(`${MARK} Псевдо Старый`);
  }, 120_000);

  it('занятое имя — отказ с названной причиной', async () => {
    // Псевдоним уникален на всю площадку: иначе один поставщик выглядел бы у клиента
    // несколькими разными, и распределение трафика поехало бы.
    const one = await createPartner(`${MARK} Занятый Один`, `${MARK} Псевдо Занятый`);
    const two = await createPartner(`${MARK} Занятый Два`, `${MARK} Псевдо Свободный`);

    const response = await api().inject({
      method: 'PUT',
      url: `/partners/${two}/alias`,
      headers: adminAuth,
      payload: { displayName: `${MARK} Псевдо Занятый` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('занят');
    expect(one).toBeDefined();
  }, 120_000);

  it('своё же имя отказом не считается', async () => {
    const target = await createPartner(`${MARK} Тот Же`, `${MARK} Псевдо Тот Же`);
    expect(await rename(target, `${MARK} Псевдо Тот Же`)).toBe(200);
  }, 120_000);

  it('пишет в журнал прежнее и новое имя', async () => {
    const target = await createPartner(`${MARK} Журнальный Псевдо`, `${MARK} Псевдо До`);
    expect(await rename(target, `${MARK} Псевдо После`)).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=partner.alias_renamed&entityId=${target}`,
      headers: adminAuth,
    });
    const entries = response.json<{ entries: { before: unknown; after: unknown }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.before).toEqual({ display_name: `${MARK} Псевдо До` });
    expect(entries[0]?.after).toEqual({ display_name: `${MARK} Псевдо После` });
  }, 120_000);

  it('несуществующий партнёр — 404, клиенту закрыто', async () => {
    expect(await rename('01890a5d-ac96-774b-bcce-b302099a8057', 'Партнёр 99')).toBe(404);

    const denied = await api().inject({
      method: 'PUT',
      url: `/partners/${firstId}/alias`,
      headers: clientAuth,
      payload: { displayName: 'Партнёр 98' },
    });
    expect(denied.statusCode).toBe(403);
  }, 120_000);
});
