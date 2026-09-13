/**
 * Разделы кабинета, открытые поддержке, — целиком ли они ей читаются.
 *
 * Проверка не про роль как таковую: право `support` на каждый отдельный обработчик
 * уже проверено в своём модуле. Здесь вопрос другой и возникает он от навигации:
 * **раздел открывается целиком или не открывается вовсе**. Страница «Партнёры
 * и оборудование» делает десяток запросов, и один админский среди них превращает
 * открытый раздел в экран с отказом посреди данных.
 *
 * Обратная половина не менее важна: у поддержки не должно получиться ничего изменить.
 * Спрятанная в браузере кнопка — вежливость, а не рубеж
 * ([access.ts](../../../../web/src/lib/access.ts)); рубеж здесь.
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
let admin = '';
let support = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7942${String(1000000 + msisdnCounter)}`;
};

async function post(url: string, payload: Record<string, unknown>, token = admin) {
  return api().inject({ method: 'POST', url, headers: as(token), payload });
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

async function createUser(role: 'admin' | 'support' | 'client' | 'partner'): Promise<{
  id: string;
  token: string;
}> {
  const { IdentityService } = await import('./identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Сотрудник',
    role,
    status: 'active',
  });
  return { id: created.id, token: await login(email) };
}

/** Идентификаторы, из которых складываются адреса разделов. */
const ids = {
  user: '',
  client: '',
  channel: '',
  partner: '',
  gateway: '',
  operator: '',
  node: '',
};

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const owner = await createUser('admin');
  admin = owner.token;
  ids.user = owner.id;
  support = (await createUser('support')).token;

  ids.operator = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  ids.node = (await post('/nodes', { name: unique('Узел') })).json<{
    node: { id: string };
  }>().node.id;

  ids.client = (
    await post('/clients', {
      ownerUserId: (await createUser('client')).id,
      name: unique('Такси'),
    })
  ).json<{ client: { id: string } }>().client.id;
  ids.channel = (await post('/channels', { clientId: ids.client, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;

  ids.partner = (
    await post('/partners', {
      ownerUserId: (await createUser('partner')).id,
      name: unique('Иванов'),
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;

  ids.gateway = (
    await post('/gateways', { partnerId: ids.partner, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${ids.gateway}/ports`, { portNumber: 1 });
  await post('/sim-cards', {
    partnerId: ids.partner,
    operatorId: ids.operator,
    msisdn: nextMsisdn(),
  });
  await post('/sip-trunks', {
    partnerId: ids.partner,
    nodeId: ids.node,
    name: unique('Транк'),
    proxyHost: 'sip.provider.test',
    registersOutbound: false,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/**
 * Что запрашивает каждый раздел кабинета.
 *
 * Список ведётся рядом со страницей, а не выводится из кода: сверяться с ним —
 * ручная работа, но альтернатива ей не «автоматическая проверка», а её отсутствие.
 * Появился в разделе новый запрос — строка сюда, и раздел проверен целиком.
 */
function sections(): { name: string; reads: string[] }[] {
  return [
    { name: 'Учётные записи', reads: ['/users?limit=50'] },
    {
      name: 'Клиенты и деньги',
      reads: [
        '/clients?limit=50',
        `/clients/${ids.client}/funds`,
        `/clients/${ids.client}/entries?limit=20`,
        `/channels?clientId=${ids.client}`,
      ],
    },
    {
      name: 'Партнёры и оборудование',
      reads: [
        '/partners?limit=50',
        `/partners/${ids.partner}/entries?limit=20`,
        `/gateways?partnerId=${ids.partner}`,
        `/sim-cards?partnerId=${ids.partner}`,
        `/gateways/${ids.gateway}/ports`,
        `/sip-trunks?partnerId=${ids.partner}`,
        `/partners/${ids.partner}/coverage`,
        `/partner-rates?partnerId=${ids.partner}`,
        '/operators',
      ],
    },
    {
      name: 'Тарифы и наценка',
      reads: ['/price-bands', '/price-bands/violations', '/commission-rules', '/clients?limit=200'],
    },
  ];
}

describe('поддержка читает открытые ей разделы целиком', () => {
  it.each(sections().map((section) => section.name))(
    '%s',
    async (name) => {
      const section = sections().find((candidate) => candidate.name === name);
      if (section === undefined) throw new Error(`Раздел ${name} не описан`);

      for (const url of section.reads) {
        const response = await api().inject({ method: 'GET', url, headers: as(support) });
        // Отказ на одном запросе означает раздел с дырой посреди данных, а не «почти
        // работает»: человек видит часть таблицы и сообщение об ошибке рядом.
        expect(`${url} → ${String(response.statusCode)}`).toBe(`${url} → 200`);
      }
    },
    60_000,
  );
});

describe('и не меняет в них ничего', () => {
  it('каждое изменяющее обращение отвечает отказом', async () => {
    const writes: { method: 'POST' | 'PATCH' | 'PUT'; url: string; payload: object }[] = [
      { method: 'PATCH', url: `/users/${ids.user}/status`, payload: { status: 'suspended' } },
      { method: 'POST', url: '/clients', payload: { ownerUserId: ids.user, name: 'Чужой' } },
      { method: 'PATCH', url: `/clients/${ids.client}/status`, payload: { status: 'suspended' } },
      {
        method: 'PATCH',
        url: `/clients/${ids.client}/overdraft`,
        payload: { overdraftLimit: '100' },
      },
      {
        method: 'POST',
        url: `/clients/${ids.client}/deposit`,
        payload: { amount: '1', idempotencyKey: 'x', description: 'y' },
      },
      { method: 'POST', url: '/channels', payload: { clientId: ids.client, name: 'Линия' } },
      { method: 'POST', url: `/channels/${ids.channel}/status`, payload: { status: 'active' } },
      { method: 'POST', url: '/partners', payload: { ownerUserId: ids.user, name: 'Кто-то' } },
      { method: 'PATCH', url: `/partners/${ids.partner}/status`, payload: { status: 'verified' } },
      { method: 'PUT', url: `/partners/${ids.partner}/alias`, payload: { displayName: 'Чужой' } },
      {
        method: 'PUT',
        url: `/partners/${ids.partner}/coverage`,
        payload: { regions: ['Республика Татарстан'] },
      },
      {
        method: 'POST',
        url: '/gateways',
        payload: { partnerId: ids.partner, name: 'Шлюз', type: 'goip' },
      },
      { method: 'POST', url: `/gateways/${ids.gateway}/status`, payload: { status: 'active' } },
      { method: 'POST', url: `/gateways/${ids.gateway}/ports`, payload: { portNumber: 2 } },
      {
        method: 'POST',
        url: '/sim-cards',
        payload: { partnerId: ids.partner, operatorId: ids.operator, msisdn: nextMsisdn() },
      },
      {
        method: 'POST',
        url: '/partner-rates',
        payload: { partnerId: ids.partner, operatorId: ids.operator, pricePerMinute: '2' },
      },
      {
        method: 'POST',
        url: '/price-bands',
        payload: { operatorId: ids.operator, minPrice: '1', maxPrice: '5' },
      },
      { method: 'POST', url: '/commission-rules', payload: { percentBasisPoints: 1500 } },
      {
        method: 'POST',
        url: '/sip-trunks',
        payload: {
          partnerId: ids.partner,
          nodeId: ids.node,
          name: 'Транк',
          proxyHost: 'sip.provider.test',
          registersOutbound: false,
        },
      },
    ];

    for (const write of writes) {
      const response = await api().inject({
        method: write.method,
        url: write.url,
        headers: as(support),
        payload: write.payload,
      });
      expect(`${write.method} ${write.url} → ${String(response.statusCode)}`).toBe(
        `${write.method} ${write.url} → 403`,
      );
    }
  }, 120_000);
});
