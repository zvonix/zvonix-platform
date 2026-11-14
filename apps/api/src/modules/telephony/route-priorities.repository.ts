/**
 * Маршруты клиента — отдельные SIM и SIP-провайдеры партнёров — и порядок клиента по ним
 * ([ADR-0120](../../../../../docs/adr/0120-poryadok-otdelnyh-sim-i-sip-u-klienta.md)).
 */

import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { clientRoutePriorities } from '@zvonix/db/schema';
import { newId, type Id, type TerminationKind } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

/** Маршрут так, как его знает площадка; клиенту из него уходят только номер внутри партнёра и цена. */
export interface RouteRow {
  readonly kind: TerminationKind;
  /** SIM — её идентификатор, SIP-провайдер — идентификатор его шлюза. */
  readonly id: string;
  readonly partnerId: Id<'partner'>;
  /** Порядковый номер среди всех карт (провайдеров) партнёра по времени заведения: «SIM 4». */
  readonly number: number;
  /** Свой тариф карты, иначе тариф шлюза; пусто — тариф партнёра по умолчанию (ADR-0056). */
  readonly tariffId: Id<'partnerTariff'> | null;
  /** Может ли маршрут принять вызов прямо сейчас: карта и шлюз в работе. */
  readonly available: boolean;
  readonly createdAt: Date;
}

export interface RoutePriorityEntry {
  readonly simCardId: Id<'simCard'> | null;
  readonly gatewayId: Id<'gateway'> | null;
  /** Пусто — «не использовать». */
  readonly priority: number | null;
}

export type RoutePriorityRow = typeof clientRoutePriorities.$inferSelect;

@Injectable()
export class RoutePrioritiesRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Карты и SIP-провайдеры этих партнёров, кроме выведенных из работы. Номер считается по **всем** картам партнёра,
   * включая выведенные: карты не удаляются, и номер «SIM 4» не сдвигается, когда партнёр выводит «SIM 2».
   */
  async listRoutes(partnerIds: readonly Id<'partner'>[]): Promise<RouteRow[]> {
    if (partnerIds.length === 0) return [];
    const ids = sql.join(
      partnerIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await this.database.db.execute(sql`
      select 'sim' as kind, s.id, s.partner_id, s.number, coalesce(s.tariff_id, g.tariff_id) as tariff_id,
             (s.status = 'active' and coalesce(g.status = 'active', false)) as available, s.created_at
        from (select sim_cards.*,
                     row_number() over (partition by partner_id order by created_at, id) as number
                from sim_cards where partner_id in (${ids})) s
        left join gateway_ports p on p.sim_card_id = s.id
        left join gateways g on g.id = p.gateway_id
       where s.status <> 'retired'
      union all
      select 'sip' as kind, t.id, t.partner_id, t.number, t.tariff_id, (t.status = 'active') as available, t.created_at
        from (select gateways.*,
                     row_number() over (partition by partner_id order by created_at, id) as number
                from gateways where partner_id in (${ids}) and type = 'sip_trunk') t
       where t.status <> 'retired'
       order by 3, 1, 4
    `);
    return result.rows.map((row) => ({
      kind: row['kind'] as TerminationKind,
      id: row['id'] as string,
      partnerId: row['partner_id'] as Id<'partner'>,
      number: Number(row['number']),
      tariffId: (row['tariff_id'] ?? null) as Id<'partnerTariff'> | null,
      available: row['available'] === true,
      createdAt: new Date(row['created_at'] as string | Date),
    }));
  }

  async list(clientId: Id<'client'>): Promise<RoutePriorityRow[]> {
    return this.database.db
      .select()
      .from(clientRoutePriorities)
      .where(eq(clientRoutePriorities.clientId, clientId));
  }

  /**
   * Заменяет строки маршрутов клиента целиком одной транзакцией: список — это порядок, и менять его частями значит
   * на время оставить клиента с порядком, которого он не задавал. Отметки очереди переживают замену.
   */
  async replace(clientId: Id<'client'>, entries: readonly RoutePriorityEntry[]): Promise<void> {
    const keyOf = (row: { simCardId: string | null; gatewayId: string | null }): string =>
      row.simCardId === null ? `sip:${String(row.gatewayId)}` : `sim:${row.simCardId}`;
    try {
      await this.database.db.transaction(async (tx) => {
        const scope = eq(clientRoutePriorities.clientId, clientId);
        const kept = await tx.select().from(clientRoutePriorities).where(scope);
        const routed = new Map(kept.map((row) => [keyOf(row), row.lastRoutedAt]));
        await tx.delete(clientRoutePriorities).where(scope);
        if (entries.length === 0) return;
        await tx.insert(clientRoutePriorities).values(
          entries.map((entry) => ({
            id: newId<'clientRoutePriority'>(),
            clientId,
            simCardId: entry.simCardId,
            gatewayId: entry.gatewayId,
            priority: entry.priority,
            lastRoutedAt: routed.get(keyOf(entry)) ?? null,
          })),
        );
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }
}
