/**
 * Письмо о низком балансе на настоящей базе
 * ([ADR-0060](../../../../../docs/adr/0060-pismo-o-nizkom-balanse.md)).
 *
 * Проверяются условия, при которых письмо **не** должно уходить, не меньше, чем то,
 * при котором уходит: лишнее письмо о деньгах хуже пропущенного.
 */

import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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

async function service() {
  const { LowBalanceService } = await import('./low-balance.service.js');
  return api().get(LowBalanceService);
}

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  const response = await api().inject({
    method: 'PUT',
    url: '/settings',
    headers: admin,
    payload: { settings },
  });
  expect(response.statusCode).toBe(200);
}

/** Клиент с работающей карточкой, подтверждённой почтой и заданной суммой на счёте. */
async function createClient(options: {
  deposit: string;
  confirmed?: boolean;
}): Promise<{ id: string; email: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const identity = api().get(IdentityService);
  const user = await identity.createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Проверка писем',
    role: 'member',
    status: 'active',
  });
  // Заведённая администратором запись почту не подтверждает: подтверждаем явно, кроме случая,
  // когда проверяется как раз неподтверждённый адрес.
  if (options.confirmed !== false) {
    await withDatabase(async (execute) => {
      await execute(sql`update users set email_confirmed_at = now() where id = ${user.id}`);
    });
  }
  const created = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: admin,
    payload: { ownerUserId: user.id, name: unique('Клиент') },
  });
  const id = created.json<{ client: { id: string } }>().client.id;
  await api().inject({
    method: 'PATCH',
    url: `/clients/${id}/status`,
    headers: admin,
    payload: { status: 'active' },
  });
  if (options.deposit !== '0') {
    await api().inject({
      method: 'POST',
      url: `/clients/${id}/deposit`,
      headers: admin,
      payload: {
        amount: options.deposit,
        idempotencyKey: unique('deposit'),
        description: 'Под проверку письма',
      },
    });
  }
  return { id, email };
}

async function lowBalanceMessages(email: string): Promise<string[]> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select body from outbox_messages where recipient = ${email} and kind = 'low_balance'`,
    );
    return result.rows.map((row) => (row as { body: string }).body);
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
  admin = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('письмо о низком балансе', () => {
  it('по умолчанию выключено: ничего не уходит', async () => {
    const poor = await createClient({ deposit: '5' });

    expect(await (await service()).notify(new Date())).toBe(0);
    expect(await lowBalanceMessages(poor.email)).toEqual([]);
  }, 120_000);

  it('включено: письмо получает тот, у кого меньше порога, и только он', async () => {
    const poor = await createClient({ deposit: '50' });
    const rich = await createClient({ deposit: '5000' });
    await setSettings({
      'notifications.low_balance_enabled': true,
      'notifications.low_balance_amount': 100,
    });

    await (await service()).notify(new Date());

    const bodies = await lowBalanceMessages(poor.email);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('можно потратить 50 ₽');
    expect(await lowBalanceMessages(rich.email)).toEqual([]);
  }, 120_000);

  it('повторный проход письмо не дублирует, через три дня напоминает снова', async () => {
    const poor = await createClient({ deposit: '10' });

    const first = await (await service()).notify(new Date());
    expect(first).toBeGreaterThan(0);
    await (await service()).notify(new Date());
    expect(await lowBalanceMessages(poor.email)).toHaveLength(1);

    // Через четверо суток письмо снова положено: напоминание, а не разовое событие.
    await (await service()).notify(new Date(Date.now() + 4 * 86_400_000));
    expect(await lowBalanceMessages(poor.email)).toHaveLength(2);
  }, 120_000);

  it('на неподтверждённый адрес не пишет', async () => {
    const stranger = await createClient({ deposit: '1', confirmed: false });

    await (await service()).notify(new Date());

    expect(await lowBalanceMessages(stranger.email)).toEqual([]);
  }, 120_000);

  it('выключение останавливает рассылку', async () => {
    await setSettings({ 'notifications.low_balance_enabled': false });
    const poor = await createClient({ deposit: '2' });

    expect(await (await service()).notify(new Date())).toBe(0);
    expect(await lowBalanceMessages(poor.email)).toEqual([]);
  }, 120_000);
});
