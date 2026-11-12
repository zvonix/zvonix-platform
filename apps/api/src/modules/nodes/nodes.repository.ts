/**
 * Запросы к реестру узлов АТС (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { orderByText, toDatabaseError, type Database } from '@zvonix/db';
import { nodeCommands, nodes } from '@zvonix/db/schema';
import { newId, ROUTABLE_NODE_STATUSES, type Id, type NodeStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type NodeId = Id<'node'>;
export type NodeRow = typeof nodes.$inferSelect;
export type NodeCommandRow = typeof nodeCommands.$inferSelect;
export type NodeCommandId = Id<'nodeCommand'>;

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
    lastAddress: string | null,
  ): Promise<NodeRow | undefined> {
    try {
      const [row] = await this.db
        .update(nodes)
        .set({ hostname, agentVersion, lastAddress, status: 'installing' })
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
    beat: {
      status: NodeStatus;
      activeCalls: number;
      agentVersion: string | null;
      setVersion: string | null;
      lastAddress: string | null;
      at: Date;
    },
  ): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .update(nodes)
      .set({
        status: beat.status,
        activeCalls: beat.activeCalls,
        agentVersion: beat.agentVersion,
        setVersion: beat.setVersion,
        // Пустой адрес пульса прежний не стирает: узнать адрес узла заново негде.
        ...(beat.lastAddress === null ? {} : { lastAddress: beat.lastAddress }),
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

  /**
   * Адрес SIP, определённый площадкой (ADR-0113) — **только если он пуст**. Условие в самом запросе:
   * пульс и правка администратора могут прийти одновременно, и пульс не должен затереть правку.
   */
  async fillSipAddress(id: NodeId, address: string): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .update(nodes)
      .set({ sipAddress: address })
      .where(and(eq(nodes.id, id), isNull(nodes.sipAddress)))
      .returning();
    return row;
  }

  /** Название и адрес SIP из настроек узла; `null` у адреса — определить по пульсу заново. */
  async updateSettings(
    id: NodeId,
    settings: { name: string; sipAddress: string | null },
  ): Promise<NodeRow | undefined> {
    try {
      const [row] = await this.db.update(nodes).set(settings).where(eq(nodes.id, id)).returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async setStatus(id: NodeId, status: NodeStatus): Promise<NodeRow | undefined> {
    const [row] = await this.db.update(nodes).set({ status }).where(eq(nodes.id, id)).returning();
    return row;
  }

  /**
   * Закрывает узел и освобождает имя машины: оно уникально, и новая установка на той же машине
   * упиралась бы в закрытый узел.
   */
  async close(id: NodeId): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .update(nodes)
      .set({ status: 'decommissioned', hostname: null })
      .where(eq(nodes.id, id))
      .returning();
    return row;
  }

  /** Снимает имя машины с узла, закрытого до того, как закрытие стало его освобождать. */
  async clearHostname(id: NodeId): Promise<void> {
    await this.db.update(nodes).set({ hostname: null }).where(eq(nodes.id, id));
  }

  /** Узел по имени машины — для сверки `hostname` из запроса маршрута с ключом. */
  async findByHostname(hostname: string): Promise<NodeRow | undefined> {
    const [row] = await this.db
      .select()
      .from(nodes)
      .where(sql`${nodes.hostname} = ${hostname}`);
    return row;
  }

  // --- Команды узлу (ADR-0115) ---------------------------------------------------------

  async enqueueCommand(nodeId: NodeId, command: string, takeBefore: Date): Promise<NodeCommandRow> {
    const [row] = await this.db
      .insert(nodeCommands)
      .values({ id: newId<'nodeCommand'>(), nodeId, command, takeBefore })
      .returning();
    if (row === undefined) throw new Error('Вставка не вернула строку');
    return row;
  }

  async findCommand(id: NodeCommandId): Promise<NodeCommandRow | undefined> {
    const [row] = await this.db.select().from(nodeCommands).where(eq(nodeCommands.id, id));
    return row;
  }

  /** Служба команд узла спросила команды — узел умеет их брать. */
  async markCommandsPolled(nodeId: NodeId, at: Date): Promise<void> {
    await this.db.update(nodes).set({ commandsPolledAt: at }).where(eq(nodes.id, nodeId));
  }

  /**
   * Взять старейшую невзятую команду узла, срок которой не истёк. `skip locked` — два долгих запроса одного узла
   * (перезапуск службы, два экземпляра API) не возьмут одну команду дважды.
   */
  async claimCommand(nodeId: NodeId, at: Date): Promise<NodeCommandRow | undefined> {
    const waiting = this.db
      .select({ id: nodeCommands.id })
      .from(nodeCommands)
      .where(
        and(
          eq(nodeCommands.nodeId, nodeId),
          isNull(nodeCommands.takenAt),
          gt(nodeCommands.takeBefore, at),
        ),
      )
      .orderBy(nodeCommands.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });
    const [row] = await this.db
      .update(nodeCommands)
      .set({ takenAt: at })
      .where(inArray(nodeCommands.id, waiting))
      .returning();
    return row;
  }

  /** Ответ узла на взятую им команду. `undefined` — команда не его, не взята или уже выполнена. */
  async finishCommand(
    nodeId: NodeId,
    id: NodeCommandId,
    reply: string,
    at: Date,
  ): Promise<NodeCommandRow | undefined> {
    const [row] = await this.db
      .update(nodeCommands)
      .set({ reply, finishedAt: at })
      .where(
        and(
          eq(nodeCommands.id, id),
          eq(nodeCommands.nodeId, nodeId),
          isNotNull(nodeCommands.takenAt),
          isNull(nodeCommands.finishedAt),
        ),
      )
      .returning();
    return row;
  }

  /** Убрать команды, поставленные раньше `before`. Возвращает, сколько убрано. */
  async purgeCommands(before: Date): Promise<number> {
    const removed = await this.db
      .delete(nodeCommands)
      .where(lt(nodeCommands.createdAt, before))
      .returning({ id: nodeCommands.id });
    return removed.length;
  }
}
