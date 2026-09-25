/**
 * Запросы к реестру узлов АТС (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { orderByText, toDatabaseError, type Database } from '@zvonix/db';
import { nodes } from '@zvonix/db/schema';
import { newId, ROUTABLE_NODE_STATUSES, type Id, type NodeStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type NodeId = Id<'node'>;
export type NodeRow = typeof nodes.$inferSelect;

@Injectable()
export class NodesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  async create(draft: { name: string; sipAddress: string | null }): Promise<NodeRow> {
    try {
      const [row] = await this.db
        .insert(nodes)
        .values({ id: newId<'node'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findById(id: NodeId): Promise<NodeRow | undefined> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, id));
    return row;
  }

  async list(): Promise<NodeRow[]> {
    return this.db.select().from(nodes).orderBy(orderByText(nodes.name));
  }

  /** Узлы, на которые допустимо направлять вызовы. */
  async listRoutable(): Promise<NodeRow[]> {
    return this.db
      .select()
      .from(nodes)
      .where(inArray(nodes.status, [...ROUTABLE_NODE_STATUSES]))
      .orderBy(orderByText(nodes.name));
  }

  /**
   * Отмечает узел зарегистрированным.
   *
   * `hostname` заполняется здесь: до установки настоящее имя машины неизвестно.
   * Уникальность имени обеспечивает частичный индекс — два узла с одним `hostname`
   * означали бы, что запрос маршрута нельзя достоверно отнести к узлу.
   */
  async markInstalling(
    id: NodeId,
    hostname: string,
    agentVersion: string | null,
  ): Promise<NodeRow | undefined> {
    try {
      const [row] = await this.db
        .update(nodes)
        .set({ hostname, agentVersion, status: 'installing' })
        .where(eq(nodes.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Записывает зашифрованный пароль ESL узла (ADR-0055). */
  async setEslSecret(id: NodeId, eslSecret: string): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .update(nodes)
      .set({ eslSecret })
      .where(eq(nodes.id, id))
      .returning();
    return row;
  }

  async recordHeartbeat(
    id: NodeId,
    beat: { status: NodeStatus; activeCalls: number; agentVersion: string | null; at: Date },
  ): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .update(nodes)
      .set({
        status: beat.status,
        activeCalls: beat.activeCalls,
        agentVersion: beat.agentVersion,
        lastHeartbeatAt: beat.at,
      })
      .where(eq(nodes.id, id))
      .returning();
    return row;
  }

  /**
   * Переводит замолчавшие узлы в `offline`.
   *
   * Выполняется одним запросом, а не чтением с последующей записью: узлов немного,
   * но два экземпляра control plane иначе перетирали бы состояние друг друга.
   * `decommissioned` не трогается — из него не возвращаются.
   */
  async markSilentOffline(deadline: Date): Promise<NodeId[]> {
    const rows = await this.db
      .update(nodes)
      .set({ status: 'offline', activeCalls: 0 })
      .where(
        and(
          inArray(nodes.status, [...ROUTABLE_NODE_STATUSES]),
          ne(nodes.status, 'decommissioned'),
          // Узел, ни разу не приславший heartbeat, сюда не попадает: он ещё
          // не выходил в online, и его состояние описывает установку, а не отказ.
          lt(nodes.lastHeartbeatAt, deadline),
        ),
      )
      .returning({ id: nodes.id });
    return rows.map((row) => row.id);
  }

  async setStatus(id: NodeId, status: NodeStatus): Promise<NodeRow | undefined> {
    const [row] = await this.db.update(nodes).set({ status }).where(eq(nodes.id, id)).returning();
    return row;
  }

  /** Узел по имени машины — для сверки `hostname` из запроса маршрута с ключом. */
  async findByHostname(hostname: string): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .select()
      .from(nodes)
      .where(sql`${nodes.hostname} = ${hostname}`);
    return row;
  }
}
