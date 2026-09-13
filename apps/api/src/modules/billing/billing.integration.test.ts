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
