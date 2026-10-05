/**
 * Аккаунты MAX партнёров на реальной базе, провайдер — имитация (ADR-0071).
 */

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
import { sql } from 'drizzle-orm';
import { MessagingService } from './messaging.service.js';
import { simulateAccountState } from './simulated.provider.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function account(
  role: 'admin' | 'client' | 'partner',
): Promise<{ id: string; token: string }> {
  const email = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { id: created.id, token: login.json<{ token: string }>().token };
}

/** Партнёр, допущенный к работе, и его сессия. */
async function verifiedPartner(): Promise<{ partnerId: string; token: string }> {
  const owner = await account('partner');
  const created = await api().inject({
    method: 'POST',
    url: '/partners',
    headers: bearer(adminToken),
    payload: {
      ownerUserId: owner.id,
      name: `Партнёр ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      displayName: `Псевдоним ${String(Math.random()).slice(2, 8)}`,
    },
  });
  expect(created.statusCode).toBe(201);
  const partnerId = created.json<{ partner: { id: string } }>().partner.id;
  const verified = await api().inject({
    method: 'PATCH',
    url: `/partners/${partnerId}/status`,
    headers: bearer(adminToken),
    payload: { status: 'verified' },
  });
  expect(verified.statusCode).toBe(200);
  return { partnerId, token: owner.token };
}

const setSetting = (key: string, value: unknown) =>
  api().inject({
    method: 'PUT',
    url: '/settings',
    headers: bearer(adminToken),
    payload: { settings: { [key]: value } },
  });

interface AccountView {
  id: string;
  label: string;
  status: string;
  phone: string | null;
  price: string | null;
  limit_per_minute: number | null;
  limit_per_day: number | null;
}

const create = (token: string, label = 'Основной') =>
  api().inject({
    method: 'POST',
    url: '/partner/messenger/accounts',
    headers: bearer(token),
    payload: { label },
  });

async function instanceOf(accountId: string): Promise<{ instance: string; token: string }> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select provider_instance_id as instance, provider_token as token
            from messenger_accounts where id = ${accountId}`,
    );
    return result.rows[0] as { instance: string; token: string };
  });
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await account('admin')).token;
});

afterAll(async () => {
  await app?.close();
});

describe('проверка ключа провайдера', () => {
  it('администратор получает ответ о ключе, остальные роли — 403, провайдер не называется', async () => {
    const ok = await api().inject({
      method: 'POST',
      url: '/messenger/provider/test',
      headers: bearer(adminToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });
    expect(ok.body).not.toMatch(/green/iu);

    const partner = await verifiedPartner();
    const denied = await api().inject({
      method: 'POST',
      url: '/messenger/provider/test',
      headers: bearer(partner.token),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('заведение аккаунта', () => {
  it('пока продукт выключен, аккаунт не заводится и раздел сообщает об этом', async () => {
    const partner = await verifiedPartner();
    const listed = await api().inject({
      method: 'GET',
      url: '/partner/messenger/accounts',
      headers: bearer(partner.token),
    });
    expect(listed.json()).toEqual({ enabled: false, accounts: [] });
    expect((await create(partner.token)).statusCode).toBe(409);
  });

  it('включённый продукт: аккаунт ждёт входа, провайдера и ключей в ответе нет, ключ в базе зашифрован', async () => {
    expect((await setSetting('messaging.enabled', true)).statusCode).toBe(200);
    const partner = await verifiedPartner();

    const created = await create(partner.token, 'Основной');
    expect(created.statusCode).toBe(201);
    const view = created.json<{ account: AccountView }>().account;
    expect(view).toMatchObject({ label: 'Основной', status: 'pending', phone: null, price: null });

    // Что партнёру положено знать — и ничего от провайдера.
    expect(Object.keys(view).sort()).toEqual([
      'created_at',
      'id',
      'label',
      'limit_per_day',
      'limit_per_minute',
      'phone',
      'price',
      'state_checked_at',
      'status',
    ]);
    expect(created.body).not.toMatch(/provider|instance|token|green/iu);

    const stored = await instanceOf(view.id);
    expect(stored.instance).toMatch(/^sim-/u);
    expect(stored.token).not.toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('аккаунты заводит допущенный партнёр, предел числа аккаунтов, чужая роль — 403', async () => {
    await setSetting('messaging.enabled', true);
    const client = await account('client');
    expect((await create(client.token)).statusCode).toBe(403);

    const partner = await verifiedPartner();
    for (let i = 0; i < 20; i += 1) {
      expect((await create(partner.token, `Аккаунт ${String(i)}`)).statusCode).toBe(201);
    }
    expect((await create(partner.token, 'Лишний')).statusCode).toBe(409);
  });
});

describe('вход по QR-коду и состояние', () => {
  it('QR выдаётся картинкой; отсканировали — аккаунт рабочий и с номером', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;

    const qr = await api().inject({
      method: 'GET',
      url: `/partner/messenger/accounts/${id}/qr`,
      headers: bearer(partner.token),
    });
    expect(qr.json<{ status: string; image: string }>()).toMatchObject({ status: 'qr' });
    expect(qr.json<{ image: string }>().image).toMatch(/^data:image\/png;base64,/u);

    simulateAccountState((await instanceOf(id)).instance, 'authorized', '79990001122');
    const after = await api().inject({
      method: 'GET',
      url: `/partner/messenger/accounts/${id}/qr`,
      headers: bearer(partner.token),
    });
    expect(after.json()).toEqual({ status: 'authorized' });

    const listed = (
      await api().inject({
        method: 'GET',
        url: '/partner/messenger/accounts',
        headers: bearer(partner.token),
      })
    ).json<{ accounts: AccountView[] }>().accounts;
    expect(listed[0]).toMatchObject({ status: 'active', phone: '79990001122' });
  });

  it('фоновая сверка: вышедший из MAX аккаунт становится недоступным, вернувшийся — рабочим', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;
    const { instance } = await instanceOf(id);
    const messaging = api().get(MessagingService);
    const later = () => new Date(Date.now() + 3_600_000);
    const status = async () =>
      (
        await api().inject({
          method: 'GET',
          url: '/partner/messenger/accounts',
          headers: bearer(partner.token),
        })
      ).json<{ accounts: AccountView[] }>().accounts[0]?.status;

    simulateAccountState(instance, 'authorized', '79990003344');
    await messaging.refreshDue(later());
    expect(await status()).toBe('active');

    simulateAccountState(instance, 'not_authorized');
    await messaging.refreshDue(new Date(later().getTime() + 3_600_000));
    expect(await status()).toBe('unavailable');

    simulateAccountState(instance, 'authorized', '79990003344');
    await messaging.refreshDue(new Date(later().getTime() + 7_200_000));
    expect(await status()).toBe('active');
  });
});

describe('цена и лимиты партнёра', () => {
  async function ownAccount() {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;
    const patch = (payload: Record<string, unknown>, token = partner.token) =>
      api().inject({
        method: 'PATCH',
        url: `/partner/messenger/accounts/${id}`,
        headers: bearer(token),
        payload,
      });
    return { partner, id, patch };
  }

  it('партнёр задаёт цену за сообщение и лимиты, снять можно значением null', async () => {
    const { patch } = await ownAccount();

    const set = await patch({
      price: '0.45',
      limitPerMinute: 10,
      limitPerDay: 500,
      label: 'Рабочий',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ account: AccountView }>().account).toMatchObject({
      label: 'Рабочий',
      price: '0.45',
      limit_per_minute: 10,
      limit_per_day: 500,
    });

    const cleared = await patch({ price: null, limitPerMinute: null });
    expect(cleared.json<{ account: AccountView }>().account).toMatchObject({
      price: null,
      limit_per_minute: null,
      limit_per_day: 500,
    });
  });

  it('негодные цена и лимиты отвергаются, а действие пишется в журнал', async () => {
    const { id, patch } = await ownAccount();
    expect((await patch({ price: '0' })).statusCode).toBe(400);
    expect((await patch({ price: '100.01' })).statusCode).toBe(400);
    expect((await patch({ price: 'много' })).statusCode).toBe(400);
    expect((await patch({ limitPerMinute: 0 })).statusCode).toBe(400);
    expect((await patch({ limitPerMinute: 100, limitPerDay: 50 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);

    expect((await patch({ price: '1' })).statusCode).toBe(200);
    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log
             where action = 'messenger_account.terms_changed' and entity_id = ${id}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(logged).toBe(1);
  });

  it('чужой аккаунт для партнёра не существует: ни прочитать, ни изменить, ни списать', async () => {
    const { id } = await ownAccount();
    const stranger = await verifiedPartner();
    const headers = bearer(stranger.token);
    expect(
      (
        await api().inject({
          method: 'PATCH',
          url: `/partner/messenger/accounts/${id}`,
          headers,
          payload: { price: '1' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api().inject({ method: 'GET', url: `/partner/messenger/accounts/${id}/qr`, headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api().inject({ method: 'DELETE', url: `/partner/messenger/accounts/${id}`, headers }))
        .statusCode,
    ).toBe(404);
  });

  it('списанный аккаунт уходит из списка, повторное списание — «не найден»', async () => {
    const { partner, id } = await ownAccount();
    const retire = () =>
      api().inject({
        method: 'DELETE',
        url: `/partner/messenger/accounts/${id}`,
        headers: bearer(partner.token),
      });
    expect((await retire()).statusCode).toBe(204);
    expect((await retire()).statusCode).toBe(404);
    const listed = await api().inject({
      method: 'GET',
      url: '/partner/messenger/accounts',
      headers: bearer(partner.token),
    });
    expect(listed.json<{ accounts: unknown[] }>().accounts).toEqual([]);
  });
});

describe('для сотрудников', () => {
  it('администратор видит все аккаунты с названием партнёра и заводит аккаунт вручную', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const manual = await api().inject({
      method: 'POST',
      url: '/messenger/accounts',
      headers: bearer(adminToken),
      payload: {
        partnerId: partner.partnerId,
        label: 'Заведён вручную',
        instanceId: 'manual-1',
        token: 'секретный-ключ-инстанса',
        apiUrl: 'https://provider.example.test',
      },
    });
    expect(manual.statusCode).toBe(201);
    // Ключ в ответ не возвращается.
    expect(manual.body).not.toContain('секретный-ключ-инстанса');

    const all = (
      await api().inject({ method: 'GET', url: '/messenger/accounts', headers: bearer(adminToken) })
    ).json<{ accounts: (AccountView & { partner_id: string; partner_name: string })[] }>().accounts;
    const row = all.find((item) => item.label === 'Заведён вручную');
    expect(row).toMatchObject({ partner_id: partner.partnerId });
    expect(row?.partner_name).toMatch(/^Партнёр /u);

    // Партнёру администраторский обработчик закрыт.
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/messenger/accounts',
          headers: bearer(partner.token),
        })
      ).statusCode,
    ).toBe(403);
  });
});
