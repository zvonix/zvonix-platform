/**
 * Деньги на реальной базе (ADR-0010).
 *
 * Проверяется то, ради чего двойная запись и существует: остаток всегда равен сумме
 * проводок, повторная операция не создаёт вторых списаний, а уйти в минус глубже
 * разрешённого нельзя. Всё это свойства транзакции в базе — без настоящей PostgreSQL
 * они не проверяются вовсе.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Money } from '@zvonix/shared';
import type { PostingLine } from './billing.service.js';
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
let token = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

/** Заводит учётную запись и возвращает её идентификатор: клиенту нужен владелец. */
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

async function createClient(overdraftLimit?: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: auth(),
    payload: {
      ownerUserId: await createUser('client'),
      name: `Такси ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      ...(overdraftLimit === undefined ? {} : { overdraftLimit }),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ client: { id: string } }>().client.id;
}

async function deposit(clientId: string, amount: string, key: string) {
  return api().inject({
    method: 'POST',
    url: `/clients/${clientId}/deposit`,
    headers: auth(),
    payload: { amount, idempotencyKey: key, description: 'Пополнение' },
  });
}

/** Прямая проверка инварианта: остаток обязан совпадать с суммой проводок. */
async function ledgerSum(clientId: string): Promise<bigint> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`
      select coalesce(sum(e.amount), 0) as total
        from ledger_entries e
        join accounts a on a.id = e.account_id
       where a.kind = 'client' and a.owner_id = ${clientId}
    `);
    return BigInt((result.rows[0] as { total: string }).total);
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
  token = login.json<{ token: string }>().token;
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('пополнение баланса', () => {
  it('начисляет деньги и оставляет след в журнале', async () => {
    // Ровно то, чем дорожная карта предлагает проверять этап 1:
    // завели клиента, начислили, увидели проводки, сошлись остатки.
    const clientId = await createClient();

    const response = await deposit(clientId, '1500.50', `deposit:${clientId}:1`);
    expect(response.statusCode).toBe(200);
    // Представление минимальное и обратимое: '1500.5' и '1500.50' — одно число,
    // но принудительные два знака потеряли бы суммы в микроединицах.
    expect(response.json()).toMatchObject({ already_posted: false, balance: '1500.5' });

    const entries = await api().inject({
      method: 'GET',
      url: `/clients/${clientId}/entries`,
      headers: auth(),
    });
    const body = entries.json<{ balance: string; entries: { amount: string }[] }>();
    expect(body.balance).toBe('1500.5');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.amount).toBe('1500.5');
  });

  it('не теряет копейки на дробных суммах', async () => {
    // Числа с плавающей точкой здесь дали бы 0.30000000000000004.
    const clientId = await createClient();
    await deposit(clientId, '0.10', `deposit:${clientId}:a`);
    await deposit(clientId, '0.20', `deposit:${clientId}:b`);

    const entries = await api().inject({
      method: 'GET',
      url: `/clients/${clientId}/entries`,
      headers: auth(),
    });
    expect(entries.json<{ balance: string }>().balance).toBe('0.3');
  });

  it('повтор с тем же ключом не начисляет второй раз', async () => {
    // Узел может прислать одно и то же повторно — это штатный режим, а не ошибка.
    const clientId = await createClient();
    const key = `deposit:${clientId}:once`;

    const first = await deposit(clientId, '100', key);
    const second = await deposit(clientId, '100', key);

    expect(first.json()).toMatchObject({ already_posted: false, balance: '100' });
    expect(second.json()).toMatchObject({ already_posted: true, balance: '100' });
    expect(first.json<{ transaction_id: string }>().transaction_id).toBe(
      second.json<{ transaction_id: string }>().transaction_id,
    );
  });

  it('одновременные повторы одного ключа не удваивают начисление', async () => {
    // Проверка на гонку: быстрая проверка ключа перед вставкой её не закрывает,
    // закрывает уникальный индекс. Без него оба запроса прошли бы проверку.
    const clientId = await createClient();
    const key = `deposit:${clientId}:race`;

    const responses = await Promise.all([
      deposit(clientId, '250', key),
      deposit(clientId, '250', key),
      deposit(clientId, '250', key),
    ]);
    for (const response of responses) expect(response.statusCode).toBe(200);

    const entries = await api().inject({
      method: 'GET',
      url: `/clients/${clientId}/entries`,
      headers: auth(),
    });
    const body = entries.json<{ balance: string; entries: unknown[] }>();
    expect(body.balance).toBe('250');
    expect(body.entries).toHaveLength(1);
  });

  it('отвергает сумму, которая не сумма', async () => {
    const clientId = await createClient();
    for (const amount of ['', 'сто рублей', '-100', '0', '1.2345678']) {
      const response = await deposit(clientId, amount, `deposit:${clientId}:${amount}`);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('журнал денег пишется той же транзакцией', () => {
  it('пополнение оставляет в журнале строку со ссылкой на проводку', async () => {
    // Без идентификатора проводки строка журнала не связана с движением денег —
    // то есть бесполезна ровно в том разборе, ради которого пишется (ADR-0034).
    const clientId = await createClient();
    const key = `deposit:${clientId}:journal`;
    const posted = await deposit(clientId, '777', key);
    expect(posted.statusCode).toBe(200);

    const rows = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select after from audit_log
             where action = 'billing.client_deposited' and entity_id = ${clientId}`,
      );
      return result.rows as { after: { transaction_id: string; amount: string } }[];
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.after.transaction_id).toBe(
      posted.json<{ transaction_id: string }>().transaction_id,
    );
    expect(rows[0]?.after.amount).toBe('777');
  });

  it('повтор с тем же ключом второй строки в журнале не создаёт', async () => {
    // Проводки нет — значит и действия не было.
    const clientId = await createClient();
    const key = `deposit:${clientId}:journal-once`;
    await deposit(clientId, '10', key);
    await deposit(clientId, '10', key);

    const count = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as count from audit_log
             where action = 'billing.client_deposited' and entity_id = ${clientId}`,
      );
      return (result.rows[0] as { count: number }).count;
    });
    expect(count).toBe(1);
  });
});

describe('инварианты двойной записи', () => {
  it('остаток равен сумме проводок', async () => {
    const clientId = await createClient();
    await deposit(clientId, '1000', `deposit:${clientId}:x1`);
    await deposit(clientId, '234.56', `deposit:${clientId}:x2`);

    const account = await api().inject({
      method: 'GET',
      url: `/clients/${clientId}/entries`,
      headers: auth(),
    });
    const stored = Money.fromMajorUnits(account.json<{ balance: string }>().balance);
    expect(await ledgerSum(clientId)).toBe(stored);
  });

  it('сумма проводок каждой операции равна нулю', async () => {
    // Деньги не возникают и не исчезают: у прихода на счёт клиента обязана быть
    // вторая сторона — расход на шлюзе платежей.
    const clientId = await createClient();
    await deposit(clientId, '777', `deposit:${clientId}:zero`);

    const unbalanced = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select transaction_id from ledger_entries
         group by transaction_id having sum(amount) <> 0
      `);
      return result.rows.length;
    });
    expect(unbalanced).toBe(0);
  });

  it('сверка не находит расхождений', async () => {
    const clientId = await createClient();
    await deposit(clientId, '42', `deposit:${clientId}:rec`);

    const response = await api().inject({
      method: 'GET',
      url: '/billing/reconcile',
      headers: auth(),
    });
    expect(response.json()).toEqual({ balanced: true, discrepancies: [] });
  });

  it('сверка замечает подделанный остаток', async () => {
    // Если бы кто-то правил остаток мимо журнала, это должно быть видно.
    const clientId = await createClient();
    await deposit(clientId, '10', `deposit:${clientId}:tamper`);

    await withDatabase(async (execute) => {
      await execute(sql`
        update accounts set balance = balance + 1000000
         where kind = 'client' and owner_id = ${clientId}
      `);
    });

    const response = await api().inject({
      method: 'GET',
      url: '/billing/reconcile',
      headers: auth(),
    });
    const body = response.json<{ balanced: boolean; discrepancies: unknown[] }>();
    expect(body.balanced).toBe(false);
    expect(body.discrepancies).toHaveLength(1);
  });
});

describe('овердрафт', () => {
  it('не пускает баланс ниже нуля без разрешённого предела', async () => {
    const clientId = await createClient();
    await deposit(clientId, '100', `deposit:${clientId}:od1`);

    const { BillingService } = await import('./billing.service.js');
    const billing = api().get(BillingService);
    const clientAccount = await billing.accountOf('client', clientId);
    const revenue = await billing.accountOf('revenue', null);

    const attempt = billing.post({
      kind: 'charge',
      idempotencyKey: `charge:${clientId}:over`,
      description: 'Списание сверх остатка',
      lines: [
        { accountId: clientAccount.id, amount: Money.fromMajorUnits('-150') },
        { accountId: revenue.id, amount: Money.fromMajorUnits('150') },
      ],
    });

    await expect(attempt).rejects.toThrow();
    // Отказ обязан откатить всё: ни проводок, ни изменения остатка.
    expect(Money.format(await billing.balanceOf('client', clientId))).toBe('100');
  });

  it('пускает в минус ровно до разрешённого предела', async () => {
    const clientId = await createClient('500');
    const { BillingService } = await import('./billing.service.js');
    const billing = api().get(BillingService);
    const clientAccount = await billing.accountOf('client', clientId);
    const revenue = await billing.accountOf('revenue', null);

    const charge = (amount: string, key: string) => {
      const lines: PostingLine[] = [
        { accountId: clientAccount.id, amount: Money.negate(Money.fromMajorUnits(amount)) },
        { accountId: revenue.id, amount: Money.fromMajorUnits(amount) },
      ];
      return billing.post({ kind: 'charge', idempotencyKey: key, description: 'Списание', lines });
    };

    await expect(charge('500', `charge:${clientId}:limit`)).resolves.toBeDefined();
    expect(Money.format(await billing.balanceOf('client', clientId))).toBe('-500');

    // На одну микроединицу глубже — уже нельзя.
    await expect(charge('0.000001', `charge:${clientId}:over`)).rejects.toThrow();
    expect(Money.format(await billing.balanceOf('client', clientId))).toBe('-500');
  });
});

describe('проводки собираются по правилам', () => {
  it('операция из одной проводки отвергается', async () => {
    const { BillingService } = await import('./billing.service.js');
    const billing = api().get(BillingService);
    const revenue = await billing.accountOf('revenue', null);

    await expect(
      billing.post({
        kind: 'correction',
        idempotencyKey: `correction:${String(Date.now())}:single`,
        description: 'Половина операции',
        lines: [{ accountId: revenue.id, amount: Money.fromMajorUnits('10') }],
      }),
    ).rejects.toThrow();
  });

  it('несходящаяся операция отвергается', async () => {
    const { BillingService } = await import('./billing.service.js');
    const billing = api().get(BillingService);
    const revenue = await billing.accountOf('revenue', null);
    const settlement = await billing.accountOf('settlement', null);

    await expect(
      billing.post({
        kind: 'correction',
        idempotencyKey: `correction:${String(Date.now())}:unbalanced`,
        description: 'Деньги из воздуха',
        lines: [
          { accountId: revenue.id, amount: Money.fromMajorUnits('10') },
          { accountId: settlement.id, amount: Money.fromMajorUnits('-9') },
        ],
      }),
    ).rejects.toThrow();
  });

  it('системный счёт каждого вида существует в единственном экземпляре', async () => {
    // Иначе журнал разъедется на два несходящихся набора проводок.
    const { BillingService } = await import('./billing.service.js');
    const billing = api().get(BillingService);

    const [first, second] = await Promise.all([
      billing.accountOf('revenue', null),
      billing.accountOf('revenue', null),
    ]);
    expect(first.id).toBe(second.id);

    const count = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as total from accounts where kind = 'revenue'`,
      );
      return (result.rows[0] as { total: number }).total;
    });
    expect(count).toBe(1);
  });
});

describe('партнёр скрыт от клиента', () => {
  it('заводится с псевдонимом, настоящее имя в ответе не появляется', async () => {
    // ADR-0014: клиент никогда не получает данных, позволяющих связаться с партнёром.
    const realName = `Иванов Иван ${String(Date.now())}`;
    const response = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: auth(),
      payload: {
        ownerUserId: await createUser('partner'),
        name: realName,
        displayName: `Партнёр ${String(Date.now()).slice(-4)}`,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(realName);
    expect(response.json<{ partner: { display_name: string } }>().partner.display_name).toMatch(
      /^Партнёр /,
    );
  });
});

describe('ручное пополнение партнёра', () => {
  async function createPartner(): Promise<string> {
    const response = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: auth(),
      payload: {
        ownerUserId: await createUser('partner'),
        name: `Партнёр ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        displayName: `Псевдоним ${String(Math.random()).slice(2, 8)}`,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ partner: { id: string } }>().partner.id;
  }

  const depositPartner = (partnerId: string, amount: string, key: string, headers = auth()) =>
    api().inject({
      method: 'POST',
      url: `/partners/${partnerId}/deposit`,
      headers,
      payload: { amount, idempotencyKey: key, description: 'Премия' },
    });

  it('добавляет к причитающемуся, и деньги видны в проводках партнёра', async () => {
    const partnerId = await createPartner();

    const response = await depositPartner(partnerId, '320.75', `partner-deposit:${partnerId}:1`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ already_posted: false, balance: '320.75' });

    const entries = await api().inject({
      method: 'GET',
      url: `/partners/${partnerId}/entries`,
      headers: auth(),
    });
    expect(entries.statusCode).toBe(200);
    expect(entries.body).toContain('320.75');
  });

  it('повтор и гонка с тем же ключом денег не добавляют', async () => {
    const partnerId = await createPartner();
    const key = `partner-deposit:${partnerId}:race`;

    const results = await Promise.all([
      depositPartner(partnerId, '100', key),
      depositPartner(partnerId, '100', key),
      depositPartner(partnerId, '100', key),
    ]);
    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    expect(
      results.filter((r) => !r.json<{ already_posted: boolean }>().already_posted),
    ).toHaveLength(1);

    const again = await depositPartner(partnerId, '100', key);
    expect(again.json()).toMatchObject({ already_posted: true, balance: '100' });
  });

  it('пополнение попадает в журнал действий той же транзакцией', async () => {
    const partnerId = await createPartner();
    await depositPartner(partnerId, '55', `partner-deposit:${partnerId}:journal`);

    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log
             where action = 'billing.partner_deposited' and entity_id = ${partnerId}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(logged).toBe(1);
  });

  it('нулевая и отрицательная суммы, несуществующий партнёр, чужая роль — отказы', async () => {
    const partnerId = await createPartner();
    expect((await depositPartner(partnerId, '0', 'partner-deposit:zero')).statusCode).toBe(400);
    expect((await depositPartner(partnerId, '-5', 'partner-deposit:minus')).statusCode).toBe(400);
    expect(
      (await depositPartner(crypto.randomUUID(), '10', 'partner-deposit:nobody')).statusCode,
    ).toBe(404);

    // Партнёр сам себе деньги не добавит.
    const ownerEmail = uniqueEmail();
    const { IdentityService } = await import('../identity/identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email: ownerEmail,
      password: TEST_PASSWORD,
      fullName: 'Сам себе',
      role: 'member',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ownerEmail, password: TEST_PASSWORD },
    });
    const stranger = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
    expect(
      (await depositPartner(partnerId, '10', 'partner-deposit:self', stranger)).statusCode,
    ).toBe(403);
  });

  const withdraw = (partnerId: string, action: 'payout' | 'debit', amount: string, key: string) =>
    api().inject({
      method: 'POST',
      url: `/partners/${partnerId}/${action}`,
      headers: auth(),
      payload: { amount, idempotencyKey: key, description: 'Перевод на карту' },
    });

  it('выплата уменьшает причитающееся, повтор с тем же ключом ничего не меняет', async () => {
    const partnerId = await createPartner();
    await depositPartner(partnerId, '500', `partner-payout:${partnerId}:in`);
    const key = `partner-payout:${partnerId}:1`;

    const first = await withdraw(partnerId, 'payout', '200.5', key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ already_posted: false, balance: '299.5' });

    const again = await withdraw(partnerId, 'payout', '200.5', key);
    expect(again.json()).toMatchObject({ already_posted: true, balance: '299.5' });

    const logged = await withdrawLogged(partnerId, 'billing.partner_paid_out');
    expect(logged).toBe(1);
  });

  it('выплатить больше причитающегося нельзя, остаток не меняется', async () => {
    const partnerId = await createPartner();
    await depositPartner(partnerId, '100', `partner-payout:${partnerId}:in`);

    const refused = await withdraw(
      partnerId,
      'payout',
      '100.01',
      `partner-payout:${partnerId}:big`,
    );
    expect(refused.statusCode).toBe(409);

    // Две выплаты в гонке по 60 из 100: пройти может только одна.
    const race = await Promise.all([
      withdraw(partnerId, 'payout', '60', `partner-payout:${partnerId}:r1`),
      withdraw(partnerId, 'payout', '60', `partner-payout:${partnerId}:r2`),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);

    const rest = await withdraw(partnerId, 'payout', '40', `partner-payout:${partnerId}:rest`);
    expect(rest.json()).toMatchObject({ balance: '0' });
  });

  it('ручное списание у партнёра — тоже не глубже нуля, и пишется в журнал', async () => {
    const partnerId = await createPartner();
    await depositPartner(partnerId, '70', `partner-debit:${partnerId}:in`);

    const ok = await withdraw(partnerId, 'debit', '20', `partner-debit:${partnerId}:1`);
    expect(ok.json()).toMatchObject({ balance: '50' });
    expect(
      (await withdraw(partnerId, 'debit', '51', `partner-debit:${partnerId}:2`)).statusCode,
    ).toBe(409);
    expect(await withdrawLogged(partnerId, 'billing.partner_debited')).toBe(1);
    expect(
      (await withdraw(partnerId, 'payout', '0', `partner-payout:${partnerId}:zero`)).statusCode,
    ).toBe(400);
  });

  async function withdrawLogged(partnerId: string, action: string): Promise<number> {
    return withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log
             where action = ${action} and entity_id = ${partnerId}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
  }
});

describe('ручное списание у клиента', () => {
  const debit = (clientId: string, amount: string, key: string) =>
    api().inject({
      method: 'POST',
      url: `/clients/${clientId}/debit`,
      headers: auth(),
      payload: { amount, idempotencyKey: key, description: 'Пополнено по ошибке' },
    });

  it('уменьшает остаток и не уводит ниже разрешённого минуса', async () => {
    const clientId = await createClient('10');
    await deposit(clientId, '100', `debit:${clientId}:in`);

    const ok = await debit(clientId, '60', `debit:${clientId}:1`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ already_posted: false, balance: '40' });

    expect((await debit(clientId, '60', `debit:${clientId}:1`)).json()).toMatchObject({
      already_posted: true,
      balance: '40',
    });

    // Остаток 40, минус разрешён до 10: можно списать 50, 50.01 — уже нет.
    expect((await debit(clientId, '50.01', `debit:${clientId}:big`)).statusCode).toBe(409);
    expect((await debit(clientId, '50', `debit:${clientId}:edge`)).json()).toMatchObject({
      balance: '-10',
    });
    expect(await ledgerSum(clientId)).toBe(-10_000_000n);
  });

  it('ноль и несуществующий клиент — отказы', async () => {
    const clientId = await createClient();
    expect((await debit(clientId, '0', 'debit:zero')).statusCode).toBe(400);
    expect((await debit(crypto.randomUUID(), '5', 'debit:nobody')).statusCode).toBe(404);
  });
});

describe('выплата партнёрам списком', () => {
  async function newPartner(): Promise<string> {
    const response = await api().inject({
      method: 'POST',
      url: '/partners',
      headers: auth(),
      payload: {
        ownerUserId: await createUser('partner'),
        name: `Партнёр ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        displayName: `Псевдоним ${String(Math.random()).slice(2, 8)}`,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ partner: { id: string } }>().partner.id;
  }

  const credit = (partnerId: string, amount: string) =>
    api().inject({
      method: 'POST',
      url: `/partners/${partnerId}/deposit`,
      headers: auth(),
      payload: { amount, idempotencyKey: `batch-in:${partnerId}`, description: 'Начислено' },
    });

  const batch = (batchKey: string, items: { partnerId: string; amount: string }[]) =>
    api().inject({
      method: 'POST',
      url: '/partners/payouts',
      headers: auth(),
      payload: { batchKey, description: 'Выплата за месяц', items },
    });

  interface Result {
    partner_id: string;
    outcome: string;
    balance: string | null;
    reason: string | null;
  }

  it('платит всем, отказ одной строки не откатывает остальные, повтор ничего не меняет', async () => {
    const [a, b, c] = [await newPartner(), await newPartner(), await newPartner()] as [
      string,
      string,
      string,
    ];
    await credit(a, '500');
    await credit(b, '300');
    await credit(c, '50');
    const key = `batch-${String(Date.now())}`;
    const items = [
      { partnerId: a, amount: '500' },
      { partnerId: b, amount: '100.5' },
      { partnerId: c, amount: '80' },
    ];

    const first = await batch(key, items);
    expect(first.statusCode).toBe(200);
    const results = first.json<{ results: Result[] }>().results;
    expect(results.map((row) => row.outcome)).toEqual(['paid', 'paid', 'refused']);
    expect(results[0]).toMatchObject({ partner_id: a, balance: '0' });
    expect(results[1]).toMatchObject({ partner_id: b, balance: '199.5' });
    expect(results[2]?.reason).toContain('причитается');

    const again = (await batch(key, items)).json<{ results: Result[] }>().results;
    expect(again.map((row) => row.outcome)).toEqual(['already_paid', 'already_paid', 'refused']);
    expect(again[1]?.balance).toBe('199.5');
  });

  it('список «кому должны» отдаёт только положительный остаток, крупные первыми', async () => {
    const small = await newPartner();
    const large = await newPartner();
    const nothing = await newPartner();
    await credit(small, '10');
    await credit(large, '9000');

    const response = await api().inject({
      method: 'GET',
      url: '/partners?owed=true&limit=200',
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ partners: { id: string }[] }>().partners.map((row) => row.id);
    expect(ids).toContain(small);
    expect(ids).toContain(large);
    expect(ids).not.toContain(nothing);
    expect(ids.indexOf(large)).toBeLessThan(ids.indexOf(small));
    expect(response.json<{ total: number }>().total).toBe(ids.length);
  });

  it('пустая партия, дубль партнёра и чужая роль — отказы', async () => {
    const partnerId = await newPartner();
    expect((await batch('batch-empty-1', [])).statusCode).toBe(400);
    expect(
      (
        await batch('batch-dup-1', [
          { partnerId, amount: '1' },
          { partnerId, amount: '2' },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api().inject({
          method: 'POST',
          url: '/partners/payouts',
          payload: { batchKey: 'batch-anon-1', description: 'x1', items: [] },
        })
      ).statusCode,
    ).toBe(401);
  });
});
