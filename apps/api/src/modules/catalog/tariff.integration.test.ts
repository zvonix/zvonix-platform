/**
 * Подбор действующего тарифа на реальной базе (ADR-0010).
 *
 * Сам расчёт проверен без базы в `packages/shared/src/tariff.test.ts`. Здесь проверяется
 * то, что живёт в запросе: какая из нескольких записей считается действующей. Ошибка
 * тут не падает — она берёт не ту цену, и обнаруживается это на сверке через месяц.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let token = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
}

async function createUser(role: 'client' | 'partner'): Promise<string> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  return created.id;
}

async function createPartner(): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/partners',
    headers: auth(),
    payload: {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName: unique('Партнёр'),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ partner: { id: string } }>().partner.id;
}

async function createClient(): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: auth(),
    payload: { ownerUserId: await createUser('client'), name: unique('Такси') },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ client: { id: string } }>().client.id;
}

async function createOperator(): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/operators',
    headers: auth(),
    payload: { name: unique('Оператор') },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ operator: { id: string } }>().operator.id;
}

async function addRate(payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url: '/partner-rates', headers: auth(), payload });
}

async function addCommission(payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url: '/commission-rules', headers: auth(), payload });
}

interface Priced {
  billed_seconds: number;
  partner_amount: string;
  commission_amount: string;
  client_amount: string;
  rate_id: string;
}

async function price(payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url: '/tariffs/price', headers: auth(), payload });
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
  expect(login.statusCode).toBe(200);
  token = login.json<{ token: string }>().token;
});

afterAll(async () => {
  await app?.close();
});

describe('подбор действующего тарифа', () => {
  it('берётся самая свежая из уже действующих записей', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '2',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    const response = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<Priced>().partner_amount).toBe('2');
  });

  it('тариф, ещё не вступивший в силу, не применяется', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '99',
      effectiveFrom: '2027-01-01T00:00:00.000Z',
    });

    const response = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(response.json<Priced>().partner_amount).toBe('1');
  });

  it('прошлое не переоценивается: цена берётся на момент звонка', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '5',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
    });

    // Инвариант DOMAIN.md: цена, применённая к звонку, фиксируется на момент звонка.
    // Тарификация CDR может выполняться позже — узел держал его на диске.
    const old = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
      at: '2026-03-01T00:00:00.000Z',
    });
    expect(old.json<Priced>().partner_amount).toBe('1');
  });

  it('региональный тариф побеждает общий, даже если общий свежее', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      region: 'Москва',
      pricePerMinute: '3',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '7',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    // Иначе новая цена по стране молча отменяла бы договорённость по региону.
    const moscow = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      region: 'Москва',
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(moscow.json<Priced>().partner_amount).toBe('3');

    // А для региона без своей цены действует общая.
    const other = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      region: 'Пермский край',
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(other.json<Priced>().partner_amount).toBe('7');
  });

  it('без действующего тарифа — отказ, а не бесплатный звонок', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    // Вызов без цены означает, что платформа не знает, сколько он стоит партнёру:
    // списать нечего, начислить нечего, а минуты SIM партнёр тратит.
    const response = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('наценка платформы', () => {
  it('правило клиента побеждает общее', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '10',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addCommission({ percentBasisPoints: 2000, effectiveFrom: '2026-01-01T00:00:00.000Z' });
    await addCommission({
      clientId: client,
      percentBasisPoints: 500,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    const response = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    const priced = response.json<Priced>();
    expect(priced.commission_amount).toBe('0.5');
    expect(priced.client_amount).toBe('10.5');
  });

  it('фикс и процент применяются вместе', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '10',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await addCommission({
      clientId: client,
      fixedFee: '0.50',
      percentBasisPoints: 1500,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    const priced = (
      await price({
        partnerId: partner,
        clientId: client,
        operatorId: operator,
        durationSeconds: 60,
        at: '2026-08-01T00:00:00.000Z',
      })
    ).json<Priced>();

    expect(priced.commission_amount).toBe('2');
    expect(priced.client_amount).toBe('12');
  });

  it('наценка выше ста процентов отвергается как опечатка в разрядах', async () => {
    const response = await addCommission({ percentBasisPoints: 15_000 });
    expect(response.statusCode).toBe(400);
  });

  it('без правила наценки — отказ: платформа работала бы в ноль и не знала бы об этом', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1',
      effectiveFrom: '2010-01-01T00:00:00.000Z',
    });

    // Момент раньше любого правила наценки, заведённого другими проверками этого файла:
    // база у них общая, и правило платформы по умолчанию видно всем клиентам.
    const response = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      durationSeconds: 60,
      at: '2010-06-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('правила тарификации из тарифа партнёра', () => {
  it('шаг, минимум и плата за соединение приезжают из базы и применяются', async () => {
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await addCommission({ percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '60',
      billingIncrementSeconds: 30,
      minimumDurationSeconds: 45,
      connectionFee: '1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    // Минимум 45, шаг 30, разговор 50 секунд → 75 секунд по 1 ₽/с плюс 1 ₽ соединения.
    const priced = (
      await price({
        partnerId: partner,
        clientId: client,
        operatorId: operator,
        durationSeconds: 50,
        at: '2026-08-01T00:00:00.000Z',
      })
    ).json<Priced>();

    expect(priced.billed_seconds).toBe(75);
    expect(priced.partner_amount).toBe('76');
  });

  it('негодные правила тарификации отвергаются при заведении', async () => {
    const partner = await createPartner();
    const operator = await createOperator();

    const zeroStep = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1',
      billingIncrementSeconds: 0,
    });
    expect(zeroStep.statusCode).toBe(400);

    const notAmount = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: 'дорого',
    });
    expect(notAmount.statusCode).toBe(400);
  });
});
