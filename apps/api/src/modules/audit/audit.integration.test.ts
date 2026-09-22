/**
 * Чтение журнала действий — `GET /audit`.
 *
 * До этого обработчика журнал писался, но прочитать его можно было только запросом
 * к базе. Проверяется, что записи, которые платформа делает сама по ходу работы,
 * действительно находятся, что отбор отбирает, и что исполнитель разворачивается
 * в человека, а не остаётся идентификатором.
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

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminAuth: Record<string, string> = {};
let supportAuth: Record<string, string> = {};
let clientAuth: Record<string, string> = {};
let adminId = '';
let subjectId = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface EntryView {
  readonly id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly actor: { id: string; email: string; full_name: string } | null;
  readonly actor_role: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly correlation_id: string | null;
}

async function create(
  role: 'admin' | 'support' | 'client',
  email: string,
): Promise<{ id: string; headers: Record<string, string> }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Иван Петров',
    role,
    status: 'active',
  });

  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return {
    id: created.id,
    headers: { authorization: `Bearer ${response.json<{ token: string }>().token}` },
  };
}

async function read(
  query: string,
  headers = adminAuth,
): Promise<{ entries: EntryView[]; total: number }> {
  const response = await api().inject({ method: 'GET', url: `/audit?${query}`, headers });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const admin = await create('admin', uniqueEmail());
  adminId = admin.id;
  adminAuth = admin.headers;

  supportAuth = (await create('support', uniqueEmail())).headers;
  clientAuth = (await create('client', uniqueEmail())).headers;

  // Действие администратора над чужой записью: у него есть и исполнитель,
  // и состояние до, и состояние после — то есть всё, ради чего журнал заведён.
  const subject = await create('client', uniqueEmail());
  subjectId = subject.id;

  const changed = await api().inject({
    method: 'PATCH',
    url: `/users/${subjectId}/status`,
    headers: adminAuth,
    payload: { status: 'suspended' },
  });
  expect(changed.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ', () => {
  it('администратор и поддержка читают журнал', async () => {
    for (const headers of [adminAuth, supportAuth]) {
      const response = await api().inject({ method: 'GET', url: '/audit', headers });
      expect(response.statusCode).toBe(200);
    }
  }, 120_000);

  it('клиенту журнал закрыт', async () => {
    const response = await api().inject({ method: 'GET', url: '/audit', headers: clientAuth });
    expect(response.statusCode).toBe(403);
  }, 120_000);

  it('без входа — отказ', async () => {
    const response = await api().inject({ method: 'GET', url: '/audit' });
    expect(response.statusCode).toBe(401);
  }, 120_000);
});

describe('содержимое', () => {
  it('находит действие администратора над учётной записью', async () => {
    const found = await read(`entityType=user&entityId=${subjectId}`);
    const entry = found.entries.find((row) => row.action === 'user.status_changed');
    expect(entry).toBeDefined();
    expect(entry?.entity_id).toBe(subjectId);
  }, 120_000);

  it('состояние до и после сохранено целиком', async () => {
    // Разбирать спор по формулировке «изменено состояние» невозможно — именно
    // поэтому в журнал кладётся изменение, а не его описание.
    const found = await read(`entityType=user&entityId=${subjectId}&action=user.status_changed`);
    const entry = found.entries[0];
    expect(entry?.before).toMatchObject({ status: 'active' });
    expect(entry?.after).toMatchObject({ status: 'suspended' });
  }, 120_000);

  it('исполнитель разворачивается в человека, а не остаётся идентификатором', async () => {
    const found = await read(`entityType=user&entityId=${subjectId}&action=user.status_changed`);
    expect(found.entries[0]?.actor?.id).toBe(adminId);
    expect(found.entries[0]?.actor?.email).toContain('@');
    expect(found.entries[0]?.actor_role).toBe('admin');
  }, 120_000);

  it('у действия системы исполнителя нет, и это тоже факт', async () => {
    const { AuditService } = await import('./audit.service.js');
    await api().get(AuditService).record({
      action: 'reservation.expired',
      entityType: 'reservation',
      entityId: 'проверка-без-исполнителя',
    });

    const found = await read('action=reservation.expired');
    expect(found.entries[0]?.actor).toBeNull();
    expect(found.entries[0]?.actor_role).toBeNull();
  }, 120_000);

  it('закрытая учётная запись не ломает чтение журнала', async () => {
    // Ссылка на исполнителя проставлена `on delete set null`, но между удалением
    // и чтением возможен и просто ненайденный идентификатор. Прочерк честнее пустоты.
    const ghost = '01920000-0000-7000-8000-00000000dead';
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into audit_log (id, actor_user_id, actor_role, action, entity_type, occurred_at)
        values (${ghost}::uuid, null, 'admin', 'проверка.призрак', 'ghost', now())
      `);
      await execute(sql`update audit_log set actor_user_id = null where id = ${ghost}::uuid`);
    });

    const found = await read('action=проверка.призрак');
    expect(found.entries[0]?.actor).toBeNull();
  }, 120_000);
});

describe('отбор', () => {
  it('по действию', async () => {
    const found = await read('action=session.created');
    expect(found.total).toBeGreaterThan(0);
    expect(found.entries.every((row) => row.action === 'session.created')).toBe(true);
  }, 120_000);

  it('по исполнителю', async () => {
    const found = await read(`actorUserId=${adminId}`);
    expect(found.total).toBeGreaterThan(0);
    expect(found.entries.every((row) => row.actor?.id === adminId)).toBe(true);
  }, 120_000);

  it('по периоду: будущее не содержит ничего', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const found = await read(`from=${encodeURIComponent(tomorrow)}`);
    expect(found.total).toBe(0);
  }, 120_000);

  it('негодный момент времени — отказ, а не молчаливо другой период', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/audit?from=позавчера',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('негодный идентификатор исполнителя — отказ', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/audit?actorUserId=не-идентификатор',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('пустые значения означают «любое»', async () => {
    const empty = await read('action=&entityType=&entityId=&from=&to=');
    const none = await read('');
    expect(empty.total).toBe(none.total);
  }, 120_000);
});

describe('страницы и порядок', () => {
  it('свежее сверху', async () => {
    const found = await read('limit=20');
    const times = found.entries.map((row) => Date.parse(row.occurred_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  }, 120_000);

  it('размер страницы ограничивает выборку, но не счёт', async () => {
    const page = await read('limit=1');
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
  }, 120_000);
});

describe('список действий', () => {
  it('спрашивается у журнала, а не перечисляется в коде', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/audit/actions',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);

    const actions = response.json<{ actions: string[] }>().actions;
    expect(actions).toContain('session.created');
    expect(actions).toContain('user.status_changed');
    // Без повторов и по порядку: это список для поля отбора.
    expect(new Set(actions).size).toBe(actions.length);
    expect([...actions].sort()).toEqual(actions);
  }, 120_000);

  it('клиенту закрыт', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/audit/actions',
      headers: clientAuth,
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);
});
