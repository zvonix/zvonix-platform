import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../infra/tokens.js';
import { PaymentNoticeService } from './payment-notice.service.js';
import { EquipmentNoticeService } from './equipment-notice.service.js';
import { DEFAULT_CHOICE, type NotificationChoice } from './notification-preferences.service.js';

const NOW = new Date('2026-10-03T12:00:00Z');

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

/** Выбор писем владельца (ADR-0104): по умолчанию всё включено. */
const preferences = (choice: Partial<NotificationChoice> = {}) =>
  ({ of: () => Promise.resolve({ ...DEFAULT_CHOICE, ...choice }) }) as never;

const owner = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'owner@example.test',
  status: 'active',
  emailConfirmedAt: new Date('2026-01-01'),
  ...overrides,
});

function mailStub(alreadySent: (kind: string, since: Date) => boolean = () => false) {
  const enqueue = vi.fn(() => Promise.resolve(true));
  return {
    enqueue,
    mail: {
      hasRecent: (kind: string, _recipient: string, since: Date) =>
        Promise.resolve(alreadySent(kind, since)),
      enqueue,
    } as never,
  };
}

describe('письмо клиенту о решении по заявке', () => {
  const payment = (overrides: Record<string, unknown> = {}) => ({
    id: 'p1',
    clientId: 'c1',
    status: 'succeeded',
    amount: 1_500_000_000n,
    receivedAmount: 1_450_000_000n,
    resolutionNote: null,
    ...overrides,
  });

  function build(options: {
    enabled?: boolean;
    payments?: Record<string, unknown>[];
    owner?: Record<string, unknown>;
    alreadySent?: (kind: string) => boolean;
    choice?: Partial<NotificationChoice>;
  }) {
    const { mail, enqueue } = mailStub(options.alreadySent);
    const service = new PaymentNoticeService(
      { resolvedSince: () => Promise.resolve(options.payments ?? []) } as never,
      {
        clientWithBalance: () => Promise.resolve({ name: 'Такси Ромашка', ownerUserId: 'u1' }),
      } as never,
      { findPublicUser: () => Promise.resolve(owner(options.owner)) } as never,
      mail,
      {
        notifications: () => Promise.resolve({ paymentDecisionEnabled: options.enabled ?? true }),
      } as never,
      preferences(options.choice),
      logger(),
    );
    return { service, enqueue };
  }

  const sent = (enqueue: ReturnType<typeof vi.fn>) =>
    (enqueue.mock.calls[0] as unknown as [{ kind: string; subject: string; body: string }])[0];

  it('клиент выключил это письмо у себя — не пишет (ADR-0104)', async () => {
    const { service, enqueue } = build({
      payments: [payment()],
      choice: { paymentDecision: false },
    });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('выключено — ничего не делает', async () => {
    const { service, enqueue } = build({ enabled: false, payments: [payment()] });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('подтверждённая: письмо называет фактически зачисленную сумму', async () => {
    const { service, enqueue } = build({ payments: [payment()] });
    expect(await service.notify(NOW)).toBe(1);
    const letter = sent(enqueue);
    expect(letter.kind).toBe('payment_resolved:p1');
    expect(letter.subject).toContain('подтверждена');
    expect(letter.body).toContain('1450');
    expect(letter.body).toContain('Такси Ромашка');
  });

  it('отклонённая: письмо называет причину', async () => {
    const { service, enqueue } = build({
      payments: [
        payment({
          status: 'rejected',
          receivedAmount: null,
          resolutionNote: 'перевод не поступил',
        }),
      ],
    });
    expect(await service.notify(NOW)).toBe(1);
    expect(sent(enqueue).subject).toContain('отклонена');
    expect(sent(enqueue).body).toContain('перевод не поступил');
  });

  it('повторно не пишет, неподтверждённому адресу не пишет', async () => {
    const again = build({
      payments: [payment()],
      alreadySent: (kind) => kind === 'payment_resolved:p1',
    });
    expect(await again.service.notify(NOW)).toBe(0);

    const stranger = build({ payments: [payment()], owner: { emailConfirmedAt: null } });
    expect(await stranger.service.notify(NOW)).toBe(0);
    expect(stranger.enqueue).not.toHaveBeenCalled();
  });
});

describe('письмо партнёру об оборудовании', () => {
  function build(options: {
    enabled?: boolean;
    gateways?: Record<string, unknown>[];
    sims?: Record<string, unknown>[];
    poorSims?: Record<string, unknown>[];
    poorGateways?: Record<string, unknown>[];
    partnerStatus?: string;
    alreadySent?: (kind: string, since: Date) => boolean;
    gatewaysFail?: boolean;
    qualityFail?: boolean;
    choice?: Partial<NotificationChoice>;
  }) {
    const { mail, enqueue } = mailStub(options.alreadySent);
    const service = new EquipmentNoticeService(
      {
        listGateways: () =>
          options.gatewaysFail === true
            ? Promise.reject(new Error('база недоступна'))
            : Promise.resolve(options.gateways ?? []),
        listSims: () => Promise.resolve(options.sims ?? []),
      } as never,
      {
        poorlyConnecting: () =>
          options.qualityFail === true
            ? Promise.reject(new Error('база недоступна'))
            : Promise.resolve({
                sims: options.poorSims ?? [],
                gateways: options.poorGateways ?? [],
              }),
      } as never,
      {
        partnerWithBalance: () =>
          Promise.resolve({ status: options.partnerStatus ?? 'verified', ownerUserId: 'u1' }),
      } as never,
      { findPublicUser: () => Promise.resolve(owner()) } as never,
      mail,
      {
        notifications: () => Promise.resolve({ partnerSuspensionEnabled: options.enabled ?? true }),
      } as never,
      preferences(options.choice),
      logger(),
    );
    return { service, enqueue };
  }

  const gateway = (overrides: Record<string, unknown> = {}) => ({
    id: 'g1',
    partnerId: 'pt1',
    name: 'GOIP-гараж',
    status: 'suspended',
    suspendedBy: 'failure_threshold',
    ...overrides,
  });
  const sim = (overrides: Record<string, unknown> = {}) => ({
    id: 's1',
    partnerId: 'pt1',
    msisdn: '79161000001',
    status: 'throttled',
    ...overrides,
  });

  it('выключено — ничего не делает', async () => {
    const { service, enqueue } = build({ enabled: false, gateways: [gateway()] });
    expect(await service.notify(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('пишет об отключённых порогом шлюзе и SIM, а не об отключённых людьми', async () => {
    const { service, enqueue } = build({
      gateways: [
        gateway(),
        gateway({ id: 'g2', suspendedBy: 'partner' }),
        gateway({ id: 'g3', status: 'active', suspendedBy: null }),
      ],
      sims: [sim(), sim({ id: 's2', status: 'active' })],
    });

    expect(await service.notify(NOW)).toBe(2);
    const kinds = enqueue.mock.calls.map((call) => (call as unknown as [{ kind: string }])[0].kind);
    expect(kinds).toEqual(['suspended:gateway:g1', 'suspended:sim:s1']);
  });

  it('напоминание в пределах срока не уходит, партнёру не в работе не пишет', async () => {
    const reminded = build({
      sims: [sim()],
      alreadySent: (kind) => kind === 'suspended:sim:s1',
    });
    expect(await reminded.service.notify(NOW)).toBe(0);

    const idle = build({ sims: [sim()], partnerStatus: 'suspended' });
    expect(await idle.service.notify(NOW)).toBe(0);
  });

  it('сбой чтения шлюзов не гасит письмо о SIM', async () => {
    const { service, enqueue } = build({ gatewaysFail: true, sims: [sim()] });
    expect(await service.notify(NOW)).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  // Строка качества уже отобрана правилом «почти не соединяет»; здесь — только «по вине сети» (ADR-0103, п. 5).
  const poor = (overrides: Record<string, unknown> = {}) => ({
    subjectId: 's1',
    subjectName: '79161000001',
    subjectStatus: 'active',
    partnerId: 'pt1',
    attempts: 20,
    answered: 2,
    networkFailures: 12,
    asrBasisPoints: 1000,
    ...overrides,
  });

  it('почти не соединяет из-за сети — письмо партнёру; из-за «не ответил» — нет', async () => {
    const { service, enqueue } = build({
      poorSims: [poor(), poor({ subjectId: 's2', networkFailures: 3 })],
      poorGateways: [poor({ subjectId: 'g1', subjectName: 'GOIP-гараж' })],
    });

    expect(await service.notify(NOW)).toBe(2);
    const mails = enqueue.mock.calls.map(
      (call) => (call as unknown as [{ kind: string; subject: string; body: string }])[0],
    );
    expect(mails.map((mail) => mail.kind)).toEqual([
      'poor_connection:sim:s1',
      'poor_connection:gateway:g1',
    ]);
    expect(mails[0]?.subject).toContain('SIM 79161000001 почти не соединяет');
    expect(mails[1]?.subject).toContain('Шлюз «GOIP-гараж»');
    // Партнёр не видит клиента: ни имени, ни номеров абонентов в письме нет.
    expect(mails[0]?.body).not.toMatch(/клиент/iu);
  });

  it('о плохом соединении — не чаще раза в 12 часов, об отключении — раза в трое суток', async () => {
    const asked = new Map<string, number>();
    const { service } = build({
      poorSims: [poor()],
      sims: [sim()],
      alreadySent: (kind, since) => {
        asked.set(kind, (NOW.getTime() - since.getTime()) / 3_600_000);
        return false;
      },
    });
    await service.notify(NOW);
    expect(asked.get('poor_connection:sim:s1')).toBe(12);
    expect(asked.get('suspended:sim:s1')).toBe(72);
  });

  it('партнёр выключил одно письмо — второе уходит (ADR-0104)', async () => {
    const quiet = build({
      sims: [sim()],
      poorSims: [poor({ subjectId: 's9' })],
      choice: { poorConnection: false },
    });
    expect(await quiet.service.notify(NOW)).toBe(1);
    expect(
      quiet.enqueue.mock.calls.map((call) => (call as unknown as [{ kind: string }])[0].kind),
    ).toEqual(['suspended:sim:s1']);

    const none = build({
      sims: [sim()],
      poorSims: [poor({ subjectId: 's9' })],
      choice: { poorConnection: false, equipmentSuspended: false },
    });
    expect(await none.service.notify(NOW)).toBe(0);
  });

  it('сбой чтения качества не гасит письмо об отключении', async () => {
    const { service, enqueue } = build({ qualityFail: true, sims: [sim()] });
    expect(await service.notify(NOW)).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
