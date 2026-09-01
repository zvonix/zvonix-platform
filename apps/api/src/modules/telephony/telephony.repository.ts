/**
 * Запросы к шлюзам партнёров и каналам клиентов (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { channels, clients, gatewayPorts, gateways, partners, simCards } from '@zvonix/db/schema';
import {
  newId,
  USABLE_PORT_STATES,
  USABLE_SIM_STATUSES,
  type ChannelStatus,
  type GatewayPortState,
  type GatewayStatus,
  type GatewayType,
  type Id,
  type Msisdn,
  type SimStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type GatewayId = Id<'gateway'>;
export type ChannelId = Id<'channel'>;
export type SimCardId = Id<'simCard'>;
export type GatewayPortId = Id<'gatewayPort'>;
export type GatewayRow = typeof gateways.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type SimCardRow = typeof simCards.$inferSelect;
export type GatewayPortRow = typeof gatewayPorts.$inferSelect;

/**
 * Кандидат на терминацию вызова: годная SIM нужного оператора вместе с портом,
 * в котором она стоит, и шлюзом, к которому этот порт относится.
 */
export interface SimCandidate {
  readonly sim: SimCardRow;
  readonly port: GatewayPortRow;
  readonly gateway: GatewayRow;
}

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

  // --- SIM-карты --------------------------------------------------------------

  async createSim(draft: {
    partnerId: Id<'partner'>;
    operatorId: Id<'operator'>;
    msisdn: Msisdn;
    iccid: string | null;
    activatedAt: Date | null;
    operatorConfirmedAt: Date | null;
  }): Promise<SimCardRow> {
    try {
      const [row] = await this.db
        .insert(simCards)
        .values({ id: newId<'simCard'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findSim(id: SimCardId): Promise<SimCardRow | undefined> {
    const [row] = await this.db.select().from(simCards).where(eq(simCards.id, id));
    return row;
  }

  async listSims(partnerId?: Id<'partner'>): Promise<SimCardRow[]> {
    const query = this.db.select().from(simCards);
    return partnerId === undefined
      ? query.orderBy(asc(simCards.msisdn))
      : query.where(eq(simCards.partnerId, partnerId)).orderBy(asc(simCards.msisdn));
  }

  async setSimStatus(id: SimCardId, status: SimStatus): Promise<SimCardRow | undefined> {
    const [row] = await this.db
      .update(simCards)
      .set({ status })
      .where(eq(simCards.id, id))
      .returning();
    return row;
  }

  /** Меняется только администратором: превышение — путь к блокировке SIM оператором. */
  async setSimConcurrency(id: SimCardId, value: number): Promise<SimCardRow | undefined> {
    try {
      const [row] = await this.db
        .update(simCards)
        .set({ maxConcurrentCalls: value })
        .where(eq(simCards.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  // --- Порты -------------------------------------------------------------------

  async createPort(draft: { gatewayId: GatewayId; portNumber: number }): Promise<GatewayPortRow> {
    try {
      const [row] = await this.db
        .insert(gatewayPorts)
        .values({ id: newId<'gatewayPort'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findPort(id: GatewayPortId): Promise<GatewayPortRow | undefined> {
    const [row] = await this.db.select().from(gatewayPorts).where(eq(gatewayPorts.id, id));
    return row;
  }

  async listPorts(gatewayId: GatewayId): Promise<GatewayPortRow[]> {
    return this.db
      .select()
      .from(gatewayPorts)
      .where(eq(gatewayPorts.gatewayId, gatewayId))
      .orderBy(asc(gatewayPorts.portNumber));
  }

  /**
   * Ставит SIM в порт или вынимает её (`null`).
   *
   * Уникальный частичный индекс не даст поставить одну SIM в два порта: иначе она
   * оказалась бы «свободна» дважды, и одновременных вызовов на ней стало бы вдвое
   * больше разрешённого — прямой путь к блокировке оператором.
   */
  async setPortSim(
    id: GatewayPortId,
    simCardId: SimCardId | null,
  ): Promise<GatewayPortRow | undefined> {
    try {
      const [row] = await this.db
        .update(gatewayPorts)
        .set({ simCardId })
        .where(eq(gatewayPorts.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async setPortState(
    id: GatewayPortId,
    state: GatewayPortState,
  ): Promise<GatewayPortRow | undefined> {
    const [row] = await this.db
      .update(gatewayPorts)
      .set({ state })
      .where(eq(gatewayPorts.id, id))
      .returning();
    return row;
  }

  // --- Отбор для маршрутизации --------------------------------------------------

  /**
   * Кандидаты на терминацию: SIM нужного оператора, годная к вызову.
   *
   * Главный запрос маршрутизации. Всё проверяется **одним запросом**: набор условий,
   * разложенный по нескольким чтениям, разъезжается между ними, и вызов уходит на SIM,
   * которую только что заблокировали.
   *
   * `excludeRecordingIncapable` исключает шлюзы типа `android`: там запись разговора
   * технически невозможна (ADR-0012), а канал с требованием записи туда
   * не маршрутизируется никогда.
   *
   * Одновременность на SIM здесь **не** проверяется: счётчик активных вызовов —
   * состояние времени выполнения, оно живёт не в этой таблице (ARCHITECTURE.md,
   * счётчики лимитов). Этот запрос отвечает на вопрос «какие SIM вообще подходят».
   */
  async findSimCandidates(
    operatorId: Id<'operator'>,
    options: { excludeRecordingIncapable: boolean } = { excludeRecordingIncapable: false },
  ): Promise<SimCandidate[]> {
    const conditions = [
      eq(simCards.operatorId, operatorId),
      inArray(simCards.status, [...USABLE_SIM_STATUSES]),
      inArray(gatewayPorts.state, [...USABLE_PORT_STATES]),
      eq(gateways.status, 'active'),
      eq(partners.status, 'verified'),
    ];
    if (options.excludeRecordingIncapable) {
      conditions.push(ne(gateways.type, 'android'));
    }

    return this.db
      .select({ sim: simCards, port: gatewayPorts, gateway: gateways })
      .from(simCards)
      .innerJoin(gatewayPorts, eq(gatewayPorts.simCardId, simCards.id))
      .innerJoin(gateways, eq(gateways.id, gatewayPorts.gatewayId))
      .innerJoin(partners, eq(partners.id, simCards.partnerId))
      .where(and(...conditions))
      .orderBy(asc(simCards.msisdn));
  }

  /** SIM, не установленные ни в один порт: партнёру они видны как «лежит в столе». */
  async listUnassignedSims(partnerId: Id<'partner'>): Promise<SimCardRow[]> {
    const rows = await this.db
      .select({ sim: simCards })
      .from(simCards)
      .leftJoin(gatewayPorts, eq(gatewayPorts.simCardId, simCards.id))
      .where(and(eq(simCards.partnerId, partnerId), isNull(gatewayPorts.id)))
      .orderBy(asc(simCards.msisdn));
    return rows.map((row) => row.sim);
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
