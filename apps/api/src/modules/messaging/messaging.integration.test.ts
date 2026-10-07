/**
 * Аккаунты MAX партнёров на реальной базе, провайдер — имитация (ADR-0071).
 */

import { readFileSync } from 'node:fs';
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
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';
import { simulateAccountState, simulateAwaitingPassword } from './simulated.provider.js';

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
      'state_reason',
      'status',
      'tariff_id',
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

  it('в MAX включён облачный пароль: QR просит его, неверный — 400, верный завершает вход', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;
    const instance = (await instanceOf(id)).instance;
    simulateAwaitingPassword(instance);

    const qr = () =>
      api().inject({
        method: 'GET',
        url: `/partner/messenger/accounts/${id}/qr`,
        headers: bearer(partner.token),
      });
    const send = (password: string, token = partner.token) =>
      api().inject({
        method: 'POST',
        url: `/partner/messenger/accounts/${id}/password`,
        headers: bearer(token),
        payload: { password },
      });

    expect((await qr()).json()).toEqual({ status: 'password' });
    expect((await send('')).statusCode).toBe(400);
    expect((await send('не-тот')).statusCode).toBe(400);
    // Чужой партнёр чужой аккаунт не трогает.
    const other = await verifiedPartner();
    expect((await send('верный-пароль', other.token)).statusCode).toBe(404);

    expect((await send('верный-пароль')).statusCode).toBe(204);
    expect((await qr()).json()).toEqual({ status: 'authorized' });
    const listed = (
      await api().inject({
        method: 'GET',
        url: '/partner/messenger/accounts',
        headers: bearer(partner.token),
      })
    ).json<{ accounts: AccountView[] }>().accounts;
    expect(listed[0]).toMatchObject({ status: 'active' });
  });

  it('недоступный аккаунт показывает причину: приостановлен, заблокирован, вышел; рабочий — без причины', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;
    const instance = (await instanceOf(id)).instance;
    const seen = async () => {
      const row = await api()
        .get(MessagingRepository)
        .findById(id as never);
      await api()
        .get(MessagingService)
        .refreshOne(row as never);
      return (
        await api().inject({
          method: 'GET',
          url: '/partner/messenger/accounts',
          headers: bearer(partner.token),
        })
      )
        .json<{ accounts: (AccountView & { state_reason: string | null })[] }>()
        .accounts.find((item) => item.id === id);
    };

    simulateAccountState(instance, 'authorized', '79990001122');
    expect(await seen()).toMatchObject({ status: 'active', state_reason: null });
    simulateAccountState(instance, 'suspended');
    expect(await seen()).toMatchObject({ status: 'unavailable', state_reason: 'suspended' });
    simulateAccountState(instance, 'blocked');
    expect(await seen()).toMatchObject({ status: 'unavailable', state_reason: 'blocked' });
    simulateAccountState(instance, 'not_authorized');
    expect(await seen()).toMatchObject({ status: 'unavailable', state_reason: 'logged_out' });
    // «Запускается» прежнюю причину не стирает: сверка могла просто не дозвониться.
    simulateAccountState(instance, 'starting');
    expect(await seen()).toMatchObject({ status: 'unavailable', state_reason: 'logged_out' });
    simulateAccountState(instance, 'authorized', '79990001122');
    expect(await seen()).toMatchObject({ status: 'active', state_reason: null });
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

describe('миграция условий аккаунтов в тарифы (0045)', () => {
  it('частое сочетание — «Основной» по умолчанию, остальные — отдельные тарифы, аккаунты без цены идут за умолчанием', async () => {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const ids: string[] = [];
    for (const label of ['Акк-1', 'Акк-2', 'Акк-3', 'Акк-4']) {
      ids.push((await create(partner.token, label)).json<{ account: AccountView }>().account.id);
    }
    const [a, b, c, d] = ids as [string, string, string, string];

    // Состояние «до миграции»: тарифов нет, условия вписаны в аккаунты.
    const sqlFile = new URL(
      '../../../../../packages/db/migrations/0045_tarify_max.sql',
      import.meta.url,
    );
    const statements = readFileSync(sqlFile, 'utf8')
      .split('--> statement-breakpoint')
      .filter(
        (part) =>
          part.includes('Данные (ADR-0075)') || part.includes('берут условия тарифа по умолчанию'),
      );
    expect(statements).toHaveLength(2);

    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set tariff_id = null where id in (${a}, ${b}, ${c}, ${d})`,
      );
      await execute(sql`delete from messenger_tariffs`);
      await execute(
        sql`update messenger_accounts set price = 450000, limit_per_minute = 10, limit_per_day = 500 where id in (${a}, ${b})`,
      );
      await execute(
        sql`update messenger_accounts set price = 900000, limit_per_minute = null, limit_per_day = null where id = ${c}`,
      );
      await execute(
        sql`update messenger_accounts set price = null, limit_per_minute = null, limit_per_day = null where id = ${d}`,
      );
      for (const statement of statements) await execute(sql.raw(statement));
    });

    const state = await withDatabase(async (execute) => {
      const tariffs = await execute(
        sql`select name, price::text as price, limit_per_minute, is_default from messenger_tariffs order by name`,
      );
      const accounts = await execute(
        sql`select label, tariff_id is not null as own, price::text as price from messenger_accounts
             where id in (${a}, ${b}, ${c}, ${d}) order by label`,
      );
      return { tariffs: tariffs.rows, accounts: accounts.rows };
    });
    expect(state.tariffs).toEqual([
      { name: 'Основной', price: '450000', limit_per_minute: 10, is_default: true },
      { name: 'Тариф 2', price: '900000', limit_per_minute: null, is_default: false },
    ]);
    expect(state.accounts).toEqual([
      { label: 'Акк-1', own: false, price: '450000' },
      { label: 'Акк-2', own: false, price: '450000' },
      { label: 'Акк-3', own: true, price: '900000' },
      // Прежде без цены, теперь — по умолчанию партнёра.
      { label: 'Акк-4', own: false, price: '450000' },
    ]);
  });
});

describe('тарифы MAX партнёра (ADR-0075)', () => {
  async function ownAccount() {
    await setSetting('messaging.enabled', true);
    const partner = await verifiedPartner();
    const { id } = (await create(partner.token)).json<{ account: AccountView }>().account;
    const rename = (payload: Record<string, unknown>, token = partner.token) =>
      api().inject({
        method: 'PATCH',
        url: `/partner/messenger/accounts/${id}`,
        headers: bearer(token),
        payload,
      });
    const tariff = (payload: Record<string, unknown>, token = partner.token) =>
      api().inject({
        method: 'POST',
        url: '/partner/messenger/tariffs',
        headers: bearer(token),
        payload,
      });
    const account = async (token = partner.token) =>
      (
        await api().inject({
          method: 'GET',
          url: '/partner/messenger/accounts',
          headers: bearer(token),
        })
      )
        .json<{ accounts: AccountView[] }>()
        .accounts.find((item) => item.id === id) as AccountView;
    const assign = (tariffId: string | null, token = partner.token) =>
      api().inject({
        method: 'PUT',
        url: `/partner/messenger/accounts/${id}/tariff`,
        headers: bearer(token),
        payload: { tariffId },
      });
    return { partner, id, rename, tariff, account, assign };
  }

  interface TariffJson {
    id: string;
    name: string;
    is_default: boolean;
    accounts: number;
  }

  it('первый тариф становится умолчанием и даёт условия аккаунту; назначение и умолчание действуют сразу', async () => {
    const { partner, tariff, account, assign } = await ownAccount();
    expect((await account()).price).toBeNull();

    const first = (
      await tariff({ name: 'Основной', price: '0.45', limitPerMinute: 10, limitPerDay: 500 })
    ).json<{ tariff: TariffJson }>().tariff;
    expect(first.is_default).toBe(true);
    expect(await account()).toMatchObject({
      tariff_id: null,
      price: '0.45',
      limit_per_minute: 10,
      limit_per_day: 500,
    });

    const second = (await tariff({ name: 'Дорогой', price: '0.9' })).json<{ tariff: TariffJson }>()
      .tariff;
    expect(second.is_default).toBe(false);
    expect((await account()).price).toBe('0.45');

    // Свой тариф перебивает умолчание; снятие возвращает к умолчанию.
    expect((await assign(second.id)).json()).toMatchObject({
      tariff_id: second.id,
      price: '0.9',
      limit_per_minute: null,
    });
    expect((await assign(null)).json()).toMatchObject({ tariff_id: null, price: '0.45' });

    // Правка тарифа и смена умолчания пересчитывают условия тех, кто за умолчанием.
    const edited = await api().inject({
      method: 'PATCH',
      url: `/partner/messenger/tariffs/${first.id}`,
      headers: bearer(partner.token),
      payload: { price: '0.5', limitPerMinute: null },
    });
    expect(edited.statusCode).toBe(200);
    expect(await account()).toMatchObject({
      price: '0.5',
      limit_per_minute: null,
      limit_per_day: 500,
    });
    const madeDefault = await api().inject({
      method: 'POST',
      url: `/partner/messenger/tariffs/${second.id}/default`,
      headers: bearer(partner.token),
    });
    expect(madeDefault.statusCode).toBe(204);
    expect((await account()).price).toBe('0.9');

    const listed = (
      await api().inject({
        method: 'GET',
        url: '/partner/messenger/tariffs',
        headers: bearer(partner.token),
      })
    ).json<{ tariffs: TariffJson[] }>().tariffs;
    expect(listed.map((item) => [item.name, item.is_default, item.accounts])).toEqual([
      ['Основной', false, 0],
      ['Дорогой', true, 1],
    ]);
  });

  it('удаляется только неиспользуемый и не умолчание; чужой тариф и тариф с аккаунтом — отказ', async () => {
    const { partner, tariff, assign } = await ownAccount();
    const main = (await tariff({ name: 'Основной', price: '0.45' })).json<{ tariff: TariffJson }>()
      .tariff;
    const extra = (await tariff({ name: 'Запасной', price: '0.6' })).json<{ tariff: TariffJson }>()
      .tariff;
    const remove = (id: string, token = partner.token) =>
      api().inject({
        method: 'DELETE',
        url: `/partner/messenger/tariffs/${id}`,
        headers: bearer(token),
      });

    expect((await remove(main.id)).statusCode).toBe(409);
    await assign(extra.id);
    expect((await remove(extra.id)).statusCode).toBe(409);
    await assign(null);

    const stranger = await verifiedPartner();
    expect((await remove(extra.id, stranger.token)).statusCode).toBe(404);
    expect((await assign(extra.id, stranger.token)).statusCode).toBe(404);

    expect((await remove(extra.id)).statusCode).toBe(204);
  });

  it('негодные цена и лимиты отвергаются; новый аккаунт сразу идёт за умолчанием; действия пишутся в журнал', async () => {
    const { partner, id, tariff, rename } = await ownAccount();
    expect((await tariff({ name: 'А', price: '0' })).statusCode).toBe(400);
    expect((await tariff({ name: 'А', price: '100.01' })).statusCode).toBe(400);
    expect((await tariff({ name: 'А', price: 'много' })).statusCode).toBe(400);
    expect((await tariff({ name: 'А', price: '1', limitPerMinute: 0 })).statusCode).toBe(400);
    expect(
      (await tariff({ name: 'А', price: '1', limitPerMinute: 100, limitPerDay: 50 })).statusCode,
    ).toBe(400);
    expect((await tariff({ name: '', price: '1' })).statusCode).toBe(400);

    expect((await tariff({ name: 'Основной', price: '0.45' })).statusCode).toBe(201);
    // Имя уникально у партнёра без учёта регистра.
    expect((await tariff({ name: 'основной', price: '1' })).statusCode).toBe(409);

    const second = (await create(partner.token, 'Второй')).json<{ account: AccountView }>().account;
    expect(second).toMatchObject({ tariff_id: null, price: '0.45' });

    // У аккаунта правится только название: цена и лимиты — в тарифе.
    expect((await rename({ label: 'Рабочий' })).statusCode).toBe(200);
    expect((await rename({})).statusCode).toBe(400);
    expect((await rename({ label: 'Рабочий', price: '5' })).statusCode).toBe(200);

    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action, count(*)::int as n from audit_log
             where action = 'messenger_tariff.created'
                or (action = 'messenger_account.terms_changed' and entity_id = ${id})
             group by action`,
      );
      return Object.fromEntries(
        (result.rows as { action: string; n: number }[]).map((row) => [row.action, row.n]),
      );
    });
    expect(logged['messenger_tariff.created']).toBeGreaterThanOrEqual(1);
    expect(logged['messenger_account.terms_changed']).toBe(2);
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
          payload: { label: 'Чужой' },
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
