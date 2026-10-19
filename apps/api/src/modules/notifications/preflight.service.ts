/**
 * Что происходит на площадке прямо сейчас — для решения «обновляться ли сейчас»
 * ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md), часть 3).
 *
 * Обновление останавливает службы на несколько секунд: идущий разговор на узле это не обрывает (он живёт на узле), а вот
 * заявку на пополнение, которую администратор подтверждает в эту минуту, лучше не оставлять на середине. Кабинет
 * показывает цифры перед кнопкой «Обновить», решает человек.
 */

import { Injectable } from '@nestjs/common';
import { BackupStatusService } from '../updates/backup-status.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { PaymentsService } from '../payments/payments.service.js';

export interface Preflight {
  readonly backup: {
    /** Когда снята самая свежая копия; `null` — копий нет или служба не писала список. */
    readonly newest_at: string | null;
    readonly age_hours: number | null;
    /** Итог проверки самой свежей копии; `null` — не проверялась. */
    readonly verified: boolean | null;
  };
  /** Разговоры, идущие сейчас на узлах (по последнему пульсу). */
  readonly active_calls: number;
  /** Заявки на пополнение, ждущие решения администратора. */
  readonly pending_payments: number;
}

const HOUR_MS = 3_600_000;

@Injectable()
export class PreflightService {
  constructor(
    private readonly backups: BackupStatusService,
    private readonly nodes: NodesService,
    private readonly payments: PaymentsService,
  ) {}

  async preflight(now: Date = new Date()): Promise<Preflight> {
    const [listing, nodes, pending] = await Promise.all([
      this.backups.listing(),
      this.nodes.list(),
      this.payments.list({ status: 'pending', limit: 1, offset: 0 }),
    ]);
    const newest = [...listing.items].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return {
      backup:
        newest === undefined
          ? { newest_at: null, age_hours: null, verified: null }
          : {
              newest_at: newest.created_at,
              age_hours: Math.max(
                0,
                Math.floor((now.getTime() - Date.parse(newest.created_at)) / HOUR_MS),
              ),
              verified: newest.check === null ? null : newest.check.ok,
            },
      // Молчащий узел разговоров не ведёт: его последнее число устарело.
      active_calls: nodes
        .filter((node) => node.status === 'online' || node.status === 'degraded')
        .reduce((sum, node) => sum + node.activeCalls, 0),
      pending_payments: pending.total,
    };
  }
}
