/**
 * Общая заготовка проверок сообщений MAX: люди, партнёр с рабочим аккаунтом, клиент с деньгами.
 * Нужна и проверкам приёма (ADR-0071), и проверкам SMPP (ADR-0072) — писать её дважды незачем.
 */

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { TEST_PASSWORD, uniqueEmail, withDatabase } from '../../testing/harness.js';
import { simulateAccountState } from './simulated.provider.js';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface Fixtures {
  user: (
    role: 'admin' | 'client' | 'partner' | 'support',
  ) => Promise<{ id: string; token: string }>;
  put: (
    token: string,
    settings: Record<string, unknown>,
  ) => ReturnType<NestFastifyApplication['inject']>;
  /** Партнёр с рабочим аккаунтом MAX, у которого назначена цена. */
  partnerWithAccount: (
    price?: string,
    limits?: Record<string, number | null>,
  ) => Promise<{ partnerId: string; ownerToken: string; accountId: string; instance: string }>;
  /** Клиент, допущенный к работе и с деньгами на счёте. */
  clientWithMoney: (amount?: string) => Promise<{ clientId: string; token: string }>;
  balance: (token: string) => Promise<string>;
}

export function fixtures(api: () => NestFastifyApplication, adminToken: () => string): Fixtures {
  async function user(role: 'admin' | 'client' | 'partner' | 'support') {
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
    return { id: created.id, token: login.json<{ token: string }>().token };
  }

  const put = (token: string, settings: Record<string, unknown>) =>
    api().inject({
      method: 'PUT',
      url: '/settings',
      headers: bearer(token),
      payload: { settings },
    });

  async function partnerWithAccount(price = '0.45', limits: Record<string, number | null> = {}) {
    const owner = await user('partner');
    const created = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: bearer(adminToken()),
      payload: {
        ownerUserId: owner.id,
        name: `Партнёр ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        displayName: `Псевдоним ${String(Math.random()).slice(2, 8)}`,
      },
    });
    const partnerId = created.json<{ partner: { id: string } }>().partner.id;
    await api().inject({
      method: 'PATCH',
      url: `/partners/${partnerId}/status`,
      headers: bearer(adminToken()),
      payload: { status: 'verified' },
    });

    const made = await api().inject({
      method: 'POST',
      url: '/partner/messenger/accounts',
      headers: bearer(owner.token),
      payload: { label: 'Основной' },
    });
    expect(made.statusCode).toBe(201);
    const accountId = made.json<{ account: { id: string } }>().account.id;
    const instance = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select provider_instance_id as instance from messenger_accounts where id = ${accountId}`,
      );
      return (result.rows[0] as { instance: string }).instance;
    });
    simulateAccountState(instance, 'authorized', '79990001122');
    // Состояние обновляется сверкой: QR-запрос с `authorized` делает её сразу.
    await api().inject({
      method: 'GET',
      url: `/partner/messenger/accounts/${accountId}/qr`,
      headers: bearer(owner.token),
    });
    // Условия — тарифом по умолчанию: аккаунт без своего тарифа идёт за ним (ADR-0075).
    const tariff = await api().inject({
      method: 'POST',
      url: '/partner/messenger/tariffs',
      headers: bearer(owner.token),
      payload: { name: 'Основной', price, isDefault: true, ...limits },
    });
    expect(tariff.statusCode).toBe(201);
    return { partnerId, ownerToken: owner.token, accountId, instance };
  }

  async function clientWithMoney(amount = '100') {
    const owner = await user('client');
    const created = await api().inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(adminToken()),
      payload: {
        ownerUserId: owner.id,
        name: `Такси ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      },
    });
    const clientId = created.json<{ client: { id: string } }>().client.id;
    await api().inject({
      method: 'PATCH',
      url: `/clients/${clientId}/status`,
      headers: bearer(adminToken()),
      payload: { status: 'active' },
    });
    if (amount !== '0') {
      await api().inject({
        method: 'POST',
        url: `/clients/${clientId}/deposit`,
        headers: bearer(adminToken()),
        payload: { amount, idempotencyKey: `dep-${clientId}`, description: 'Пополнение' },
      });
    }
    return { clientId, token: owner.token };
  }

  const balance = async (token: string): Promise<string> =>
    (await api().inject({ method: 'GET', url: '/client/account', headers: bearer(token) })).json<{
      funds: { balance: string };
    }>().funds.balance;

  return { user, put, partnerWithAccount, clientWithMoney, balance };
}
