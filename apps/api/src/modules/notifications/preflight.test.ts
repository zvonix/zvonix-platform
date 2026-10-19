import { describe, expect, it } from 'vitest';
import type { NodesService } from '../nodes/nodes.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import type { BackupStatusService } from '../updates/backup-status.service.js';
import { PreflightService } from './preflight.service.js';

const NOW = new Date('2026-10-19T12:00:00Z');

function build(setup: {
  backups?: { created_at: string; check: { ok: boolean } | null }[];
  nodes?: { status: string; activeCalls: number }[];
  pending?: number;
}) {
  const backups = {
    listing: () =>
      Promise.resolve({
        available: true,
        generated_at: null,
        last_export: null,
        items: (setup.backups ?? []).map((item, index) => ({
          id: `daily/${String(index)}.dump`,
          kind: 'daily',
          name: `${String(index)}.dump`,
          size: 1,
          created_at: item.created_at,
          check: item.check === null ? null : { at: item.created_at, detail: '', ...item.check },
        })),
      }),
  } as unknown as BackupStatusService;
  const nodes = { list: () => Promise.resolve(setup.nodes ?? []) } as unknown as NodesService;
  const payments = {
    list: () => Promise.resolve({ rows: [], total: setup.pending ?? 0 }),
  } as unknown as PaymentsService;
  return new PreflightService(backups, nodes, payments);
}

describe('что на площадке перед обновлением', () => {
  it('самая свежая копия, её возраст и итог проверки', async () => {
    const result = await build({
      backups: [
        { created_at: '2026-10-18T03:00:00Z', check: null },
        { created_at: '2026-10-19T09:00:00Z', check: { ok: true } },
      ],
    }).preflight(NOW);
    expect(result.backup).toEqual({
      newest_at: '2026-10-19T09:00:00Z',
      age_hours: 3,
      verified: true,
    });
  });

  it('копий нет — об этом и сказано, а не выдумано число', async () => {
    const result = await build({}).preflight(NOW);
    expect(result.backup).toEqual({ newest_at: null, age_hours: null, verified: null });
  });

  it('разговоры считаются только на узлах, которые на связи; заявки — ждущие решения', async () => {
    const result = await build({
      nodes: [
        { status: 'online', activeCalls: 4 },
        { status: 'degraded', activeCalls: 1 },
        { status: 'offline', activeCalls: 9 },
      ],
      pending: 2,
    }).preflight(NOW);
    expect(result.active_calls).toBe(5);
    expect(result.pending_payments).toBe(2);
  });
});
