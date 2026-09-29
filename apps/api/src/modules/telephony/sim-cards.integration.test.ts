/**
 * SIM-карты и порты шлюзов на реальной базе (ADR-0009, ADR-0013).
 *
 * Главное здесь — отбор кандидатов на терминацию. Это тот самый запрос, на котором стоит
 * маршрутизация, и его условия проверяются только вживую: набор из пяти соединений,
 * разложенный по нескольким чтениям, разъезжается между ними.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  holdTransaction,
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  waitUntilBlocked,
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

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
}

/** Номера выдаются последовательно: они уникальны по всей платформе. */
let msisdnCounter = 0;
function nextMsisdn(): string {
  msisdnCounter += 1;
  return `79${String(100000000 + msisdnCounter).slice(0, 9)}`;
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

/** Партнёр сразу подтверждённый: иначе его SIM не попадут в кандидаты. */
async function createVerifiedPartner(): Promise<string> {
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
  const id = response.json<{ partner: { id: string } }>().partner.id;
  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${id}`);
  });
  return id;
}

async function createOperator(name: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/operators',
    headers: auth(),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ operator: { id: string } }>().operator.id;
}

async function createActiveGateway(
  partnerId: string,
  type: 'goip' | 'android' = 'goip',
): Promise<string> {
  const created = await api().inject({
    method: 'POST',
    url: '/gateways',
    headers: auth(),
    // Без портов: тесты заводят их сами, с теми номерами, которые проверяют.
    payload: { partnerId, name: unique('Шлюз'), type },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ gateway: { id: string } }>().gateway.id;

  const activated = await api().inject({
    method: 'POST',
    url: `/gateways/${id}/status`,
    headers: auth(),
    payload: { status: 'active' },
  });
  expect(activated.statusCode).toBe(201);
  return id;
}

interface SimView {
  id: string;
  msisdn: string;
  status: string;
  max_concurrent_calls: number;
  operator_confirmed_at: string | null;
}

async function createSim(partnerId: string, operatorId: string, msisdn = nextMsisdn()) {
  return api().inject({
    method: 'POST',
    url: '/sim-cards',
    headers: auth(),
    payload: { partnerId, operatorId, msisdn },
  });
}

async function createActiveSim(partnerId: string, operatorId: string): Promise<SimView> {
  const created = await createSim(partnerId, operatorId);
  expect(created.statusCode).toBe(201);
  // Цена на оператор карты: куда SIM звонит, решает её тариф (ADR-0056), и без цены она
  // кандидатом не бывает. Цена именно на этот оператор — у каждого теста свой, и карты
  // соседних тестов в отбор не попадают.
  const priced = await api().inject({
    method: 'POST',
    url: '/partner-rates',
    headers: auth(),
    payload: { partnerId, operatorId, pricePerMinute: '1.00' },
  });
  expect(priced.statusCode).toBe(201);
  const sim = created.json<{ sim: SimView }>().sim;

  const activated = await api().inject({
    method: 'POST',
    url: `/sim-cards/${sim.id}/status`,
    headers: auth(),
    payload: { status: 'active' },
  });
  expect(activated.statusCode).toBe(201);
  return sim;
}

interface PortView {
  id: string;
  port_number: number;
  sim_card_id: string | null;
  state: string;
}

async function addPort(gatewayId: string, portNumber: number): Promise<PortView> {
  const response = await api().inject({
    method: 'POST',
    url: `/gateways/${gatewayId}/ports`,
    headers: auth(),
    payload: { portNumber },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ port: PortView }>().port;
}

async function installSim(portId: string, simCardId: string | null) {
  return api().inject({
    method: 'POST',
    url: `/gateway-ports/${portId}/sim`,
    headers: auth(),
    payload: { simCardId },
  });
}

/** Что записано в журнал об объекте этим действием — поля `after`, по порядку записи. */
async function auditOf(action: string, entityId: string): Promise<Record<string, unknown>[]> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`
      select after from audit_log
       where action = ${action} and entity_id = ${entityId}
       order by occurred_at, id
    `);
    return (result.rows as { after: Record<string, unknown> }[]).map((row) => row.after);
  });
}

interface Candidate {
  sim_card_id: string;
  gateway_type: string;
  port_number: number;
}

async function candidates(operatorId: string, recording = false): Promise<Candidate[]> {
  const response = await api().inject({
    method: 'GET',
    url: `/routing/sim-candidates?operatorId=${operatorId}&recording=${String(recording)}`,
    headers: auth(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ candidates: Candidate[] }>().candidates;
}

/** Полностью готовая связка: подтверждённый партнёр, активный шлюз, порт, активная SIM. */
async function readyChain(
  operatorId: string,
  type: 'goip' | 'android' = 'goip',
): Promise<{ partnerId: string; gatewayId: string; portId: string; sim: SimView }> {
  const partnerId = await createVerifiedPartner();
  const gatewayId = await createActiveGateway(partnerId, type);
  const port = await addPort(gatewayId, 1);
  const sim = await createActiveSim(partnerId, operatorId);
  expect((await installSim(port.id, sim.id)).statusCode).toBe(201);
  return { partnerId, gatewayId, portId: port.id, sim };
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

describe('заведение SIM', () => {
  it('номер нормализуется: 8-ка и плюс-семёрка дают один и тот же номер', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));

    const created = await createSim(partner, operator, '8 916 123-45-67');
    expect(created.statusCode).toBe(201);
    expect(created.json<{ sim: SimView }>().sim.msisdn).toBe('79161234567');

    // Проверяется сама нормализация, а не отказ по дублю: уникальность номера снята
    // (ADR-0043, «Ревизия: номер SIM не уникален»), и две записи с одним номером —
    // это теперь не ошибка, а разрешённое положение дел.
    const again = await createSim(partner, operator, '+7 (916) 123-45-67');
    expect(again.statusCode).toBe(201);
    expect(again.json<{ sim: SimView }>().sim.msisdn).toBe('79161234567');
  });

  it('не номер отвергается схемой', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));
    const response = await createSim(partner, operator, 'не номер');
    expect(response.statusCode).toBe(400);
  });

  it('заводится в состоянии new: в работу пускает человек', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));
    const created = await createSim(partner, operator);
    expect(created.json<{ sim: SimView }>().sim.status).toBe('new');
  });

  it('одновременных вызовов по умолчанию один', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));
    const created = await createSim(partner, operator);
    // Инвариант DOMAIN.md: превышение — прямой путь к блокировке SIM оператором.
    expect(created.json<{ sim: SimView }>().sim.max_concurrent_calls).toBe(1);
  });

  it('поднять число одновременных вызовов может администратор, но не выше предела', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));
    const sim = (await createSim(partner, operator)).json<{ sim: SimView }>().sim;

    const raised = await api().inject({
      method: 'POST',
      url: `/sim-cards/${sim.id}/concurrency`,
      headers: auth(),
      payload: { maxConcurrentCalls: 3 },
    });
    expect(raised.statusCode).toBe(201);
    expect(raised.json<{ sim: SimView }>().sim.max_concurrent_calls).toBe(3);

    const absurd = await api().inject({
      method: 'POST',
      url: `/sim-cards/${sim.id}/concurrency`,
      headers: auth(),
      payload: { maxConcurrentCalls: 100 },
    });
    expect(absurd.statusCode).toBe(400);
  });

  it('номер маскируется в журнале аудита', async () => {
    const partner = await createVerifiedPartner();
    const operator = await createOperator(unique('Оператор'));
    const created = await createSim(partner, operator, '79995550011');
    expect(created.statusCode).toBe(201);

    const recorded = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select after::text as after from audit_log where action = 'sim.created' order by occurred_at desc limit 1`,
      );
      return (result.rows[0] as { after: string }).after;
    });

    // Номер SIM — персональные данные партнёра. В журнале нужен след, а не сам номер.
    expect(recorded).not.toContain('79995550011');
    expect(recorded).toContain('7999');
  });
});

describe('порты шлюза', () => {
  it('одна SIM не встаёт в два порта', async () => {
    const partner = await createVerifiedPartner();
    const gateway = await createActiveGateway(partner);
    const first = await addPort(gateway, 1);
    const second = await addPort(gateway, 2);
    const sim = await createActiveSim(partner, await createOperator(unique('Оператор')));

    expect((await installSim(first.id, sim.id)).statusCode).toBe(201);
    // Иначе она была бы «свободна» дважды, и одновременных вызовов на ней стало бы
    // вдвое больше разрешённого — прямой путь к блокировке оператором.
    const taken = await installSim(second.id, sim.id);
    expect(taken.statusCode).toBe(409);

    // Отказ обязан называть причину: частичный уникальный индекс отвечает «такая запись
    // уже существует», и по такому ответу непонятно ни что занято, ни где искать.
    const body = taken.json<{ error: { message: string; details?: { port_id?: string } } }>();
    expect(body.error.message).toContain('в другом порту');
    expect(body.error.details?.port_id).toBe(first.id);
  });

  it('повторная установка той же SIM в тот же порт — не отказ', async () => {
    // Иначе форма, отправленная дважды, ругалась бы на состояние, которое сама
    // же и создала.
    const partner = await createVerifiedPartner();
    const gateway = await createActiveGateway(partner);
    const port = await addPort(gateway, 1);
    const sim = await createActiveSim(partner, await createOperator(unique('Оператор')));

    expect((await installSim(port.id, sim.id)).statusCode).toBe(201);
    expect((await installSim(port.id, sim.id)).statusCode).toBe(201);

    // Повтор ничего не меняет — и журнал о нём молчит: иначе в истории порта одна
    // установка выглядела бы двумя (ADR-0048).
    expect(await auditOf('gateway_port.sim_installed', port.id)).toHaveLength(1);
  });

  it('номер порта уникален в пределах шлюза', async () => {
    const partner = await createVerifiedPartner();
    const gateway = await createActiveGateway(partner);
    await addPort(gateway, 1);

    const duplicate = await api().inject({
      method: 'POST',
      url: `/gateways/${gateway}/ports`,
      headers: auth(),
      payload: { portNumber: 1 },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('чужую SIM в свой шлюз не поставить', async () => {
    const operator = await createOperator(unique('Оператор'));
    const mine = await createVerifiedPartner();
    const foreign = await createVerifiedPartner();
    const port = await addPort(await createActiveGateway(mine), 1);
    const foreignSim = await createActiveSim(foreign, operator);

    // Иначе выручка от вызова ушла бы не тому партнёру.
    expect((await installSim(port.id, foreignSim.id)).statusCode).toBe(400);
  });

  it('SIM вынимается из порта и переживает его', async () => {
    const operator = await createOperator(unique('Оператор'));
    const chain = await readyChain(operator);
    expect(await candidates(operator)).toHaveLength(1);

    expect((await installSim(chain.portId, null)).statusCode).toBe(201);
    expect(await candidates(operator)).toHaveLength(0);

    // Сама SIM осталась и может переехать в другой шлюз со своей историей.
    const listed = await api().inject({
      method: 'GET',
      url: `/sim-cards?partnerId=${chain.partnerId}`,
      headers: auth(),
    });
    expect(listed.json<{ sim_cards: SimView[] }>().sim_cards).toHaveLength(1);
  });
});

describe('одновременные изменения портов (ADR-0048)', () => {
  /** Шлюз с картами в первом и третьем портах, пустым вторым и свободной картой того же партнёра. */
  async function gatewayWithCards() {
    const operator = await createOperator(unique('Оператор'));
    const partner = await createVerifiedPartner();
    const gateway = await createActiveGateway(partner);
    const first = await addPort(gateway, 1);
    const empty = await addPort(gateway, 2);
    const third = await addPort(gateway, 3);
    for (const port of [first, third]) {
      const sim = await createActiveSim(partner, operator);
      expect((await installSim(port.id, sim.id)).statusCode).toBe(201);
    }
    const spare = await createActiveSim(partner, operator);
    return { gateway, first, empty, third, spare };
  }

  function retire(gatewayId: string) {
    return api().inject({
      method: 'POST',
      url: `/gateways/${gatewayId}/status`,
      headers: auth(),
      payload: { status: 'retired' },
    });
  }

  /**
   * Держатель запирает первый порт — списание встаёт на нём посреди своей транзакции,
   * уже сменив состояние шлюза. Ровно в этом окне и шли гонки.
   */
  async function stallRetirement(gatewayId: string, portId: string) {
    const holder = await holdTransaction(
      sql`select id from gateway_ports where id = ${portId} for update`,
    );
    const retiring = retire(gatewayId);
    const retirer = await waitUntilBlocked({ blockedBy: [holder.pid], until: retiring });
    if (retirer === 'settled') {
      await holder.release();
      throw new Error('Списание не встало в ожидание — гонки, ради которой тест, не случилось');
    }
    return { holder, retiring, retirer };
  }

  async function occupiedPorts(gatewayId: string): Promise<number> {
    return withDatabase(async (execute) => {
      const result = await execute(sql`
        select count(*)::int as count from gateway_ports
         where gateway_id = ${gatewayId} and sim_card_id is not null
      `);
      return (result.rows[0] as { count: number }).count;
    });
  }

  it.each([
    ['в пустой порт', 'empty'],
    ['поверх карты в занятом порту', 'first'],
  ] as const)(
    'установка %s во время списания получает 409, и карта в списанном шлюзе не остаётся',
    async (_case, target) => {
      const scene = await gatewayWithCards();
      const { holder, retiring, retirer } = await stallRetirement(scene.gateway, scene.first.id);
      try {
        const installing = installSim(scene[target].id, scene.spare.id);
        const waited = await waitUntilBlocked({
          blockedBy: [retirer, holder.pid],
          until: installing,
        });
        await holder.release();
        const [retired, installed] = await Promise.all([retiring, installing]);

        expect(retired.statusCode).toBe(201);
        expect(installed.statusCode).toBe(409);
        // Карта в порту списанного шлюза — тупик ADR-0043: не вынуть, не списать, не переставить.
        expect(await occupiedPorts(scene.gateway)).toBe(0);
        // Установка обязана была дождаться списания, а не прочесть шлюз ещё включённым.
        expect(waited).not.toBe('settled');
      } finally {
        await holder.release();
      }
    },
  );

  it('«вынуть» во время списания не пишет второе снятие той же карты', async () => {
    const scene = await gatewayWithCards();
    const { holder, retiring, retirer } = await stallRetirement(scene.gateway, scene.first.id);
    try {
      const removing = installSim(scene.third.id, null);
      await waitUntilBlocked({ blockedBy: [retirer, holder.pid], until: removing });
      await holder.release();
      const [retired, removed] = await Promise.all([retiring, removing]);

      expect(retired.statusCode).toBe(201);
      // Вынуть можно всегда — и из порта, который освободило списание, тоже: это не отказ.
      expect(removed.statusCode).toBe(201);
      expect(await auditOf('gateway_port.sim_removed', scene.third.id)).toEqual([
        expect.objectContaining({ sim_card_id: null, reason: 'gateway.retired' }),
      ]);
      const retirement = (await auditOf('gateway.status_changed', scene.gateway)).find(
        (after) => after['status'] === 'retired',
      );
      expect(retirement).toMatchObject({ freed_sims: 2 });
    } finally {
      await holder.release();
    }
  });
});

describe('отбор кандидатов на терминацию', () => {
  it('годная связка попадает в кандидаты', async () => {
    const operator = await createOperator(unique('Оператор'));
    const chain = await readyChain(operator);

    const found = await candidates(operator);
    expect(found).toHaveLength(1);
    expect(found[0]?.sim_card_id).toBe(chain.sim.id);
    expect(found[0]?.port_number).toBe(1);
  });

  it('SIM другого оператора не попадает', async () => {
    const wanted = await createOperator(unique('Нужный'));
    const other = await createOperator(unique('Другой'));
    await readyChain(other);

    // Экономика построена на бесплатных внутрисетевых звонках: SIM чужого оператора
    // означает платный вызов для партнёра, поэтому её здесь быть не должно.
    expect(await candidates(wanted)).toHaveLength(0);
  });

  it.each([
    ['SIM не активна', 'sim'],
    ['шлюз отключён', 'gateway'],
    ['партнёр заблокирован', 'partner'],
    ['порт неисправен', 'port'],
  ])('%s — кандидата нет', async (_name, what) => {
    const operator = await createOperator(unique('Оператор'));
    const chain = await readyChain(operator);
    expect(await candidates(operator)).toHaveLength(1);

    await withDatabase(async (execute) => {
      if (what === 'sim') {
        await execute(sql`update sim_cards set status = 'blocked' where id = ${chain.sim.id}`);
      } else if (what === 'gateway') {
        await execute(
          sql`update gateways set status = 'suspended', suspended_by = 'admin' where id = ${chain.gatewayId}`,
        );
      } else if (what === 'partner') {
        await execute(sql`update partners set status = 'suspended' where id = ${chain.partnerId}`);
      } else {
        await execute(sql`update gateway_ports set state = 'fault' where id = ${chain.portId}`);
      }
    });

    expect(await candidates(operator)).toHaveLength(0);
  });

  it('порт без отчёта оборудования кандидатом остаётся', async () => {
    const operator = await createOperator(unique('Оператор'));
    await readyChain(operator);
    // «О состоянии не отчитались» и «неисправен» — разные утверждения.
    // Пока агента нет, порт в `unknown`, и это не повод не звонить.
    expect(await candidates(operator)).toHaveLength(1);
  });

  it('канал с записью не видит шлюзов android', async () => {
    const operator = await createOperator(unique('Оператор'));
    await readyChain(operator, 'android');

    // На Android 10+ запись разговора недоступна (ADR-0012).
    expect(await candidates(operator, false)).toHaveLength(1);
    expect(await candidates(operator, true)).toHaveLength(0);
  });

  it('SIM без порта в кандидаты не попадает', async () => {
    const operator = await createOperator(unique('Оператор'));
    const partner = await createVerifiedPartner();
    await createActiveGateway(partner);
    await createActiveSim(partner, operator);

    // SIM «лежит в столе»: позвонить через неё нельзя.
    expect(await candidates(operator)).toHaveLength(0);
  });
});
