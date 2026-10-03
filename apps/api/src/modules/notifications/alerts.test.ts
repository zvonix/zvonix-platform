import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../infra/tokens.js';
import { AlertsService } from './alerts.service.js';

const NOW = new Date('2026-10-01T12:00:00Z');

const logger = (): Logger => {
  const stub = {
    child: () => stub,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return stub;
};

interface Setup {
  enabled?: boolean;
  admins?: { email: string; emailConfirmedAt: Date | null }[];
  nodes?: { id: string; name: string; status: string; lastHeartbeatAt: Date | null }[];
  sims?: Record<string, unknown>[];
  gateways?: Record<string, unknown>[];
  alreadySent?: (kind: string, recipient: string) => boolean;
  nodesFail?: boolean;
  lowDisk?: { id: string | null; name: string; freeMb: number; totalMb: number }[];
  payments?: {
    id: string;
    clientId: string;
    amount: bigint;
    comment: string | null;
    createdAt: Date;
  }[];
}

function build(setup: Setup) {
  const enqueue = vi.fn(() => Promise.resolve(true));
  const service = new AlertsService(
    {
      listUsers: () => Promise.resolve({ users: setup.admins ?? [], total: 0 }),
    } as never,
    {
      hasRecent: (kind: string, recipient: string) =>
        Promise.resolve(setup.alreadySent?.(kind, recipient) ?? false),
      enqueue,
    } as never,
    {
      notifications: () => Promise.resolve({ alertsEnabled: setup.enabled ?? true }),
    } as never,
    {
      list: () =>
        setup.nodesFail === true
          ? Promise.reject(new Error('база недоступна'))
          : Promise.resolve(setup.nodes ?? []),
    } as never,
    {
      sims: () => Promise.resolve(setup.sims ?? []),
      gateways: () => Promise.resolve(setup.gateways ?? []),
    } as never,
    { list: () => Promise.resolve({ rows: setup.payments ?? [], total: 0 }) } as never,
    { clientWithBalance: () => Promise.resolve({ name: 'Такси Ромашка' }) } as never,
    { lowDisk: () => Promise.resolve(setup.lowDisk ?? []) } as never,
    logger(),
  );
  return { service, enqueue };
}

const confirmed = { email: 'admin@example.test', emailConfirmedAt: new Date('2026-01-01') };

const quality = (overrides: Record<string, unknown>) => ({
  subjectId: 'sim-1',
  subjectName: '79990000001',
  subjectStatus: 'active',
  partnerName: 'Партнёр',
  attempts: 20,
  answered: 2,
  networkFailures: 5,
  asrBasisPoints: 1000,
  ...overrides,
});

describe('тревоги администраторам', () => {
  it('выключено — ничего не делает', async () => {
    const { service, enqueue } = build({
      enabled: false,
      admins: [confirmed],
      nodes: [{ id: 'n1', name: 'Москва-1', status: 'offline', lastHeartbeatAt: null }],
    });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('узел не на связи — письмо каждому подтверждённому администратору', async () => {
    const { service, enqueue } = build({
      admins: [confirmed, { email: 'second@example.test', emailConfirmedAt: new Date() }],
      nodes: [
        { id: 'n1', name: 'Москва-1', status: 'offline', lastHeartbeatAt: new Date('2026-10-01') },
        { id: 'n2', name: 'Омск-1', status: 'online', lastHeartbeatAt: NOW },
      ],
    });

    expect(await service.notify(NOW)).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const first = (enqueue.mock.calls[0] as unknown as [{ subject: string; kind: string }])[0];
    expect(first.subject).toContain('Москва-1');
    expect(first.kind).toBe('alert_node:n1');
  });

  it('администратору с неподтверждённой почтой не пишет', async () => {
    const { service, enqueue } = build({
      admins: [{ email: 'stranger@example.test', emailConfirmedAt: null }],
      nodes: [{ id: 'n1', name: 'Москва-1', status: 'offline', lastHeartbeatAt: null }],
    });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('повтор в пределах срока не уходит', async () => {
    const { service, enqueue } = build({
      admins: [confirmed],
      nodes: [{ id: 'n1', name: 'Москва-1', status: 'offline', lastHeartbeatAt: null }],
      alreadySent: (kind) => kind === 'alert_node:n1',
    });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('качество: тревожит только работающий объект с достаточным числом вызовов и низкой долей', async () => {
    const { service, enqueue } = build({
      admins: [confirmed],
      sims: [
        quality({ subjectId: 'bad' }),
        quality({ subjectId: 'few', attempts: 5 }),
        quality({ subjectId: 'fine', asrBasisPoints: 6000 }),
        quality({ subjectId: 'off', subjectStatus: 'throttled' }),
      ],
      gateways: [quality({ subjectId: 'gw', subjectName: 'GOIP-1' })],
    });

    expect(await service.notify(NOW)).toBe(2);
    const kinds = enqueue.mock.calls.map((call) => (call as unknown as [{ kind: string }])[0].kind);
    expect(kinds).toEqual(['alert_quality:sim:bad', 'alert_quality:gateway:gw']);
  });

  it('заявка на пополнение ждёт решения дольше пяти минут — письмо, свежая — нет', async () => {
    const { service, enqueue } = build({
      admins: [confirmed],
      payments: [
        {
          id: 'old',
          clientId: 'c1',
          amount: 1_500_000_000n,
          comment: 'платёжка 17',
          createdAt: new Date(NOW.getTime() - 6 * 60_000),
        },
        { id: 'fresh', clientId: 'c1', amount: 100_000_000n, comment: null, createdAt: NOW },
      ],
    });

    expect(await service.notify(NOW)).toBe(1);
    const sent = (
      enqueue.mock.calls[0] as unknown as [{ kind: string; subject: string; body: string }]
    )[0];
    expect(sent.kind).toBe('alert_payment:old');
    expect(sent.subject).toContain('1500');
    expect(sent.body).toContain('Такси Ромашка');
    expect(sent.body).toContain('платёжка 17');
  });

  it('мало места на диске — письмо, повтор по источнику', async () => {
    const { service, enqueue } = build({
      admins: [confirmed],
      lowDisk: [{ id: null, name: 'Площадка', freeMb: 4096, totalMb: 81920 }],
    });

    expect(await service.notify(NOW)).toBe(1);
    const sent = (enqueue.mock.calls[0] as unknown as [{ kind: string; body: string }])[0];
    expect(sent.kind).toBe('alert_disk:platform');
    expect(sent.body).toContain('5 %');
  });

  it('сбой чтения узлов не гасит тревогу о качестве', async () => {
    const { service, enqueue } = build({
      admins: [confirmed],
      nodesFail: true,
      sims: [quality({ subjectId: 'bad' })],
    });
    expect(await service.notify(NOW)).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
