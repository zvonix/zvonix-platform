/**
 * Коридоры цен (ADR-0023).
 *
 * Проверяется на реальной базе то, что живёт в запросе: какой коридор считается
 * действующим для направления и как он находится по региону. Сам расчёт стоимости
 * эталонного вызова проверен без базы в `packages/shared/src/tariff.test.ts`.
 *
 * Отдельно проверяется, что коридор **не обходится**: тариф — это пять чисел, и ограничив
 * одну лишь цену за минуту, коридор ничего бы не ограничивал.
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

async function createUser(role: 'client' | 'partner' | 'support'): Promise<string> {
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

async function addBand(payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url: '/price-bands', headers: auth(), payload });
}

async function addRate(payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url: '/partner-rates', headers: auth(), payload });
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
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('цена внутри коридора', () => {
  it('заводится, если укладывается в границы', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '2',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
  });

  it('отвергается выше верхней границы — и объясняет, чем именно', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '10',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{
        error: { details?: { reference_cost?: string; max_price?: string } };
      }>().error.details,
    ).toMatchObject({ reference_cost: '10', max_price: '3' });
  });

  it('отвергается ниже нижней границы: демпинг ограничен так же, как и наценка', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '0.10',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('коридор не обходится', () => {
  it('платой за соединение', async () => {
    // Цена за минуту внутри коридора, а вызов стоит сто рублей.
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '2',
      connectionFee: '100',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
  });

  it('минимальной длительностью в десять минут', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '2',
      minimumDurationSeconds: 600,
      billingIncrementSeconds: 60,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
  });

  it('шагом тарификации в час', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '2',
      billingIncrementSeconds: 3600,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('какой коридор действует', () => {
  it('без коридора цена не ограничена', async () => {
    // Иначе новое направление невозможно открыть, пока администратор не заведёт
    // коридор заранее и вслепую.
    const partner = await createPartner();
    const operator = await createOperator();

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '1000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
  });

  it('коридор региона побеждает общий', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    await addBand({
      operatorId: operator,
      region: 'Красноярский край',
      minPrice: '5',
      maxPrice: '9',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    // По региону — свой коридор, и цена, недопустимая по стране, здесь проходит.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          region: 'Красноярский край',
          pricePerMinute: '7',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(201);

    // А по стране действует общий: та же цена не проходит.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          pricePerMinute: '7',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('написание региона не мешает найти коридор', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      region: 'Красноярский кр.',
      minPrice: '5',
      maxPrice: '9',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      region: 'КРАСНОЯРСКИЙ КРАЙ',
      pricePerMinute: '7',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
  });

  it('берётся коридор на момент начала действия цены, а не на сегодня', async () => {
    // Иначе история цен зависела бы от того, в какой день их ввели.
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    const response = await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '50',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('региональная цена достижима', () => {
  it('находится при другом написании региона', async () => {
    // До введения ключа цена, заведённая как «Красноярский кр.», для вызова
    // в «Красноярский край» не находилась и молча подменялась общей ценой партнёра:
    // партнёр получал не ту сумму, о которой договаривался.
    const partner = await createPartner();
    const client = await createClient();
    const operator = await createOperator();
    await api().inject({
      method: 'POST',
      url: '/commission-rules',
      headers: auth(),
      payload: { percentBasisPoints: 0, effectiveFrom: '2020-01-01T00:00:00.000Z' },
    });

    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '7',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      region: 'Красноярский кр.',
      pricePerMinute: '3',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });

    const priced = await price({
      partnerId: partner,
      clientId: client,
      operatorId: operator,
      region: 'Красноярский край',
      durationSeconds: 60,
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(priced.json<{ partner_amount: string }>().partner_amount).toBe('3');
  });
});

describe('список нарушений', () => {
  it('показывает цену, оказавшуюся вне коридора после его сужения', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '10',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '8',
      effectiveFrom: '2020-02-01T00:00:00.000Z',
    });

    // Коридор сужен: строка тарифа неизменяема, и цена остаётся действовать снаружи.
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-03-01T00:00:00.000Z',
    });

    const listed = await api().inject({
      method: 'GET',
      url: '/price-bands/violations',
      headers: auth(),
    });
    expect(listed.statusCode).toBe(200);

    const violations = listed.json<{
      violations: {
        rate: { partner_id: string; price_per_minute: string };
        band: { max_price: string };
        reference_cost: string;
      }[];
    }>().violations;
    const mine = violations.find((row) => row.rate.partner_id === partner);
    expect(mine).toMatchObject({ reference_cost: '8', band: { max_price: '3' } });
  });

  it('проверяет обе цены направления: у транка своя, и она не должна теряться', async () => {
    // Направление — это оператор, регион **и способ терминации** (ADR-0040). Пока ключ
    // выборки действующих цен способ не различал, одна из двух строк молча исчезала,
    // и цена транка не проверялась коридором вовсе — при том что коридор и есть
    // единственное ограничение на цену партнёра.
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '10',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    // Обе цены заводятся внутри широкого коридора: вне его вставка их не пропустит.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          terminationKind: 'sim',
          pricePerMinute: '2',
          effectiveFrom: '2020-02-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          terminationKind: 'sip',
          pricePerMinute: '9',
          effectiveFrom: '2020-02-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(201);

    // Сужение оставляет снаружи ровно транк: SIM по-прежнему внутри.
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '3',
      effectiveFrom: '2020-03-01T00:00:00.000Z',
    });

    const listed = await api().inject({
      method: 'GET',
      url: '/price-bands/violations',
      headers: auth(),
    });
    const violations = listed.json<{
      violations: { rate: { partner_id: string; termination_kind: string } }[];
    }>().violations;
    const mine = violations.filter((row) => row.rate.partner_id === partner);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.rate.termination_kind).toBe('sip');
  });

  it('молчит, пока все цены внутри коридоров', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    await addBand({
      operatorId: operator,
      minPrice: '1',
      maxPrice: '10',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    await addRate({
      partnerId: partner,
      operatorId: operator,
      pricePerMinute: '8',
      effectiveFrom: '2020-02-01T00:00:00.000Z',
    });

    const listed = await api().inject({
      method: 'GET',
      url: '/price-bands/violations',
      headers: auth(),
    });
    const violations = listed.json<{ violations: { rate: { partner_id: string } }[] }>().violations;
    expect(violations.find((row) => row.rate.partner_id === partner)).toBeUndefined();
  });
});

describe('права', () => {
  it('поддержка читает коридоры, но не заводит', async () => {
    const operator = await createOperator();

    const email = uniqueEmail();
    const { IdentityService } = await import('../identity/identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Поддержка',
      role: 'support',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    const headers = { authorization: `Bearer ${login.json<{ token: string }>().token}` };

    expect((await api().inject({ method: 'GET', url: '/price-bands', headers })).statusCode).toBe(
      200,
    );

    const created = await api().inject({
      method: 'POST',
      url: '/price-bands',
      headers,
      payload: { operatorId: operator, minPrice: '1', maxPrice: '3' },
    });
    expect(created.statusCode).toBe(403);
  });

  it('коридор с верхней границей ниже нижней отвергается', async () => {
    const operator = await createOperator();
    const response = await addBand({ operatorId: operator, minPrice: '5', maxPrice: '1' });
    expect(response.statusCode).toBe(400);
  });
});

describe('коридор без оператора и с одной границей', () => {
  const FROM = '2020-01-01T00:00:00.000Z';
  const RATE_FROM = '2026-01-01T00:00:00.000Z';

  it('только верхняя или только нижняя граница; без обеих — отказ', async () => {
    const partner = await createPartner();
    const upper = await createOperator();
    const lower = await createOperator();

    expect(
      (await addBand({ operatorId: upper, maxPrice: '3', effectiveFrom: FROM })).statusCode,
    ).toBe(201);
    expect(
      (await addBand({ operatorId: lower, minPrice: '2', effectiveFrom: FROM })).statusCode,
    ).toBe(201);
    // Нижней границы у первого нет: копейки проходят; выше потолка — нет.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: upper,
          pricePerMinute: '0.01',
          effectiveFrom: RATE_FROM,
        })
      ).statusCode,
    ).toBe(201);
    const over = await addRate({
      partnerId: partner,
      operatorId: upper,
      pricePerMinute: '9',
      effectiveFrom: RATE_FROM,
    });
    expect(over.statusCode).toBe(400);
    const details = over.json<{ error: { details: Record<string, string> } }>().error.details;
    expect(details['max_price']).toBe('3');
    // Границы с другой стороны нет — и поля нет, а не «пусто».
    expect(details).not.toHaveProperty('min_price');

    // Верхней границы у второго нет: любая цена выше пола проходит, ниже — нет.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: lower,
          pricePerMinute: '500',
          effectiveFrom: RATE_FROM,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: lower,
          pricePerMinute: '1',
          effectiveFrom: RATE_FROM,
        })
      ).statusCode,
    ).toBe(400);

    const none = await addBand({ operatorId: upper });
    expect(none.statusCode).toBe(400);
  });

  it('снятый коридор открывает направление, а изменённый действует вместо прежнего', async () => {
    const partner = await createPartner();
    const operator = await createOperator();
    const NOW_FROM = '2020-01-01T00:00:00.000Z';
    const LATER = '2020-02-01T00:00:00.000Z';
    const RATE = '2026-01-01T00:00:00.000Z';

    expect(
      (await addBand({ operatorId: operator, maxPrice: '3', effectiveFrom: NOW_FROM })).statusCode,
    ).toBe(201);
    // Изменение — новая запись на то же направление: действует она, а не прежняя.
    expect(
      (await addBand({ operatorId: operator, maxPrice: '9', effectiveFrom: LATER })).statusCode,
    ).toBe(201);
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          pricePerMinute: '8',
          effectiveFrom: RATE,
        })
      ).statusCode,
    ).toBe(201);

    // Снять: без границ, с признаком lift. Границы вместе со снятием — отказ.
    expect((await addBand({ operatorId: operator, lift: true, maxPrice: '1' })).statusCode).toBe(
      400,
    );
    const lifted = await addBand({
      operatorId: operator,
      lift: true,
      effectiveFrom: '2020-03-01T00:00:00.000Z',
    });
    expect(lifted.statusCode).toBe(201);
    expect(
      lifted.json<{ band: { min_price: string | null; max_price: string | null } }>().band,
    ).toMatchObject({
      min_price: null,
      max_price: null,
    });
    // Направление открыто: цена выше прежнего потолка проходит.
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: operator,
          pricePerMinute: '500',
          effectiveFrom: RATE,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('«любой оператор»: ограничивает операторов без своего коридора, свой коридор побеждает', async () => {
    const partner = await createPartner();
    const withOwn = await createOperator();
    const without = await createOperator();

    const any = await addBand({ maxPrice: '5', effectiveFrom: FROM });
    expect(any.statusCode).toBe(201);
    expect(
      any.json<{ band: { operator_id: string | null; min_price: string | null } }>().band,
    ).toMatchObject({ operator_id: null, min_price: null });

    // Свой коридор шире общего и побеждает его.
    expect(
      (await addBand({ operatorId: withOwn, minPrice: '1', maxPrice: '20', effectiveFrom: FROM }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: withOwn,
          pricePerMinute: '10',
          effectiveFrom: RATE_FROM,
        })
      ).statusCode,
    ).toBe(201);

    // У оператора без своего коридора действует общий.
    const blocked = await addRate({
      partnerId: partner,
      operatorId: without,
      pricePerMinute: '10',
      effectiveFrom: RATE_FROM,
    });
    expect(blocked.statusCode).toBe(400);
    expect(
      (
        await addRate({
          partnerId: partner,
          operatorId: without,
          pricePerMinute: '4',
          effectiveFrom: RATE_FROM,
        })
      ).statusCode,
    ).toBe(201);

    // Цена «на все операторы» не обходит общий коридор.
    expect(
      (await addRate({ partnerId: partner, pricePerMinute: '10', effectiveFrom: RATE_FROM }))
        .statusCode,
    ).toBe(400);
  });

  it('список отдаёт коридор без оператора и без границ как пустые значения', async () => {
    const listed = await api().inject({ method: 'GET', url: '/price-bands', headers: auth() });
    expect(listed.statusCode).toBe(200);
    const bands = listed.json<{
      bands: { operator_id: string | null; min_price: string | null; max_price: string | null }[];
    }>().bands;
    expect(bands.some((band) => band.operator_id === null && band.max_price === '5')).toBe(true);
    expect(bands.some((band) => band.operator_id !== null && band.max_price === null)).toBe(true);
  });
});
