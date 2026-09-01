/**
 * Запросы к шлюзам партнёров и каналам клиентов (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { channels, clients, gateways, partners } from '@zvonix/db/schema';
import {
  newId,
  type ChannelStatus,
  type GatewayStatus,
  type GatewayType,
  type Id,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type GatewayId = Id<'gateway'>;
export type ChannelId = Id<'channel'>;
export type GatewayRow = typeof gateways.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;

@Injectable()
export class TelephonyRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  // --- Шлюзы -----------------------------------------------------------------

  async createGateway(draft: {
    partnerId: Id<'partner'>;
    name: string;
    type: GatewayType;
    status: GatewayStatus;
    sipUsername: string;
    a1Hash: string;
    model: string | null;
    portCount: number;
  }): Promise<GatewayRow> {
    try {
      const [row] = await this.db
        .insert(gateways)
        .values({ id: newId<'gateway'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findGateway(id: GatewayId): Promise<GatewayRow | undefined> {
    const [row] = await this.db.select().from(gateways).where(eq(gateways.id, id));
    return row;
  }

  async listGateways(partnerId?: Id<'partner'>): Promise<GatewayRow[]> {
    const query = this.db.select().from(gateways);
    const rows =
      partnerId === undefined
        ? await query.orderBy(asc(gateways.name))
        : await query.where(eq(gateways.partnerId, partnerId)).orderBy(asc(gateways.name));
    return rows;
  }

  async setGatewayStatus(id: GatewayId, status: GatewayStatus): Promise<GatewayRow | undefined> {
    const [row] = await this.db
      .update(gateways)
      .set({ status })
      .where(eq(gateways.id, id))
      .returning();
    return row;
  }

  async replaceGatewayCredentials(
    id: GatewayId,
    sipUsername: string,
    a1Hash: string,
  ): Promise<GatewayRow | undefined> {
    try {
      const [row] = await this.db
        .update(gateways)
        .set({ sipUsername, a1Hash })
        .where(eq(gateways.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Отметка об успешной регистрации: на каком узле и когда. */
  async recordRegistration(id: GatewayId, nodeId: Id<'node'>, at: Date): Promise<void> {
    await this.db.update(gateways).set({ nodeId, registeredAt: at }).where(eq(gateways.id, id));
  }

  // --- Каналы ----------------------------------------------------------------

  async createChannel(draft: {
    clientId: Id<'client'>;
    name: string;
    status: ChannelStatus;
    sipUsername: string;
    a1Hash: string;
    recordingRequired: boolean;
    callerId: string | null;
  }): Promise<ChannelRow> {
    try {
      const [row] = await this.db
        .insert(channels)
        .values({ id: newId<'channel'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findChannel(id: ChannelId): Promise<ChannelRow | undefined> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    return row;
  }

  async listChannels(clientId?: Id<'client'>): Promise<ChannelRow[]> {
    const query = this.db.select().from(channels);
    const rows =
      clientId === undefined
        ? await query.orderBy(asc(channels.name))
        : await query.where(eq(channels.clientId, clientId)).orderBy(asc(channels.name));
    return rows;
  }

  async setChannelStatus(id: ChannelId, status: ChannelStatus): Promise<ChannelRow | undefined> {
    const [row] = await this.db
      .update(channels)
      .set({ status })
      .where(eq(channels.id, id))
      .returning();
    return row;
  }

  // --- Поиск учётной записи для каталога --------------------------------------

  /**
   * Действующий шлюз по имени учётной записи SIP.
   *
   * **Состояние владельца проверяется тем же запросом.** Отдельной проверки шлюза мало:
   * заблокированный партнёр с активным шлюзом продолжал бы регистрироваться — то есть
   * ровно то свойство, ради которого каталог и отдаётся из control plane, не работало бы.
   */
  async findRegistrableGateway(sipUsername: string): Promise<GatewayRow | undefined> {
    const [row] = await this.db
      .select({ gateway: gateways })
      .from(gateways)
      .innerJoin(partners, eq(partners.id, gateways.partnerId))
      .where(
        and(
          eq(gateways.sipUsername, sipUsername),
          eq(gateways.status, 'active'),
          eq(partners.status, 'verified'),
        ),
      );
    return row?.gateway;
  }

  /** То же для канала: клиент, у которого закрыт доступ, не должен звонить. */
  async findActiveChannel(sipUsername: string): Promise<ChannelRow | undefined> {
    const [row] = await this.db
      .select({ channel: channels })
      .from(channels)
      .innerJoin(clients, eq(clients.id, channels.clientId))
      .where(
        and(
          eq(channels.sipUsername, sipUsername),
          eq(channels.status, 'active'),
          eq(clients.status, 'active'),
        ),
      );
    return row?.channel;
  }
}
