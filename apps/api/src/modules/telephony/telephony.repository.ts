/**
 * Запросы к шлюзам партнёров и каналам клиентов (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import {
  channelPartnerPriorities,
  channels,
  clients,
  gatewayPorts,
  gateways,
  partnerCoverage,
  partners,
  simCards,
} from '@zvonix/db/schema';
import {
  newId,
  normalizeRegion,
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
export type PartnerPriorityRow = typeof channelPartnerPriorities.$inferSelect;
export type PartnerCoverageRow = typeof partnerCoverage.$inferSelect;
export type PartnerId = Id<'partner'>;

/** Исполнитель запроса: пул или транзакция. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

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
   * Кандидаты на терминацию: годная SIM нужного оператора — сразу в том порядке,
   * в котором их надо перебирать.
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
   *
   * Порядок задаёт клиент приоритетами партнёров в канале (ADR-0014), а **не цена**:
   * цена определяет, сколько клиент заплатит, но не то, к кому вызов пойдёт первым.
   * Равные приоритеты чередуются по давности последнего маршрута (ADR-0021).
   *
   * Список приоритетов **закрытый**: партнёра, которого в нём нет, канал не использует.
   * Но пустой список означает «все партнёры» — иначе новый канал не смог бы позвонить,
   * пока кто-то не заполнит список, и это выглядело бы поломкой, а не настройкой.
   *
   * Регион номера отсекает партнёров, которые в него не звонят (ADR-0022). Правило то же:
   * список закрытый, пустой означает «все регионы».
   */
  async findSimCandidates(
    operatorId: Id<'operator'>,
    options: {
      channelId?: ChannelId;
      excludeRecordingIncapable?: boolean;
      /**
       * Регион номера. Отсутствие поля и `null` — **разные** вещи: без поля покрытие
       * не проверяется вовсе (так спрашивает разбор «какие SIM вообще подходят»),
       * а `null` означает «регион неизвестен» и оставляет только партнёров без списка.
       */
      region?: string | null;
    } = {},
  ): Promise<SimCandidate[]> {
    const channelId = options.channelId;
    // Спрашивается именно наличие строк у канала, а не наличие приоритета у кандидата:
    // клиент мог перечислить партнёров, у которых сейчас нет свободной SIM, и тогда
    // среди кандидатов приоритетов не окажется вовсе. Считать это «список не заполнен»
    // значит позвонить через партнёра, которого клиент из списка исключил.
    const configured = channelId !== undefined && (await this.hasPartnerPriorities(channelId));

    const conditions = [
      eq(simCards.operatorId, operatorId),
      inArray(simCards.status, [...USABLE_SIM_STATUSES]),
      inArray(gatewayPorts.state, [...USABLE_PORT_STATES]),
      eq(gateways.status, 'active'),
      eq(partners.status, 'verified'),
    ];
    if (options.excludeRecordingIncapable === true) {
      conditions.push(ne(gateways.type, 'android'));
    }
    if (options.region !== undefined) {
      conditions.push(coversRegion(options.region));
    }
    if (configured) {
      conditions.push(isNotNull(channelPartnerPriorities.id));
    }

    return this.db
      .select({ sim: simCards, port: gatewayPorts, gateway: gateways })
      .from(simCards)
      .innerJoin(gatewayPorts, eq(gatewayPorts.simCardId, simCards.id))
      .innerJoin(gateways, eq(gateways.id, gatewayPorts.gatewayId))
      .innerJoin(partners, eq(partners.id, simCards.partnerId))
      .leftJoin(
        channelPartnerPriorities,
        channelId === undefined
          ? sql`false`
          : and(
              eq(channelPartnerPriorities.channelId, channelId),
              eq(channelPartnerPriorities.partnerId, simCards.partnerId),
            ),
      )
      .where(and(...conditions))
      .orderBy(
        // Без приоритета партнёр идёт последним, а не первым: `NULL` в сортировке
        // PostgreSQL по возрастанию оказался бы в конце и так, но полагаться на это
        // молча — значит поменять порядок при первом же `desc`.
        sql`coalesce(${channelPartnerPriorities.priority}, 2147483647) asc`,
        sql`${channelPartnerPriorities.lastRoutedAt} asc nulls first`,
        asc(simCards.msisdn),
      );
  }

  /** Заполнен ли у канала список партнёров. */
  async hasPartnerPriorities(channelId: ChannelId): Promise<boolean> {
    const [row] = await this.db
      .select({ id: channelPartnerPriorities.id })
      .from(channelPartnerPriorities)
      .where(eq(channelPartnerPriorities.channelId, channelId))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Отмечает, что партнёру выдали маршрут по этому каналу.
   *
   * Обязательно **той же транзакцией**, что занимает место на SIM (ADR-0021): отдельным
   * запросом после — значит потерять отметку при сбое и раздавать очередь одному и тому же
   * партнёру. У канала без списка отмечать нечего, и отсутствие строки здесь не ошибка.
   */
  async markPartnerRouted(
    channelId: ChannelId,
    partnerId: PartnerId,
    at: Date,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(channelPartnerPriorities)
      .set({ lastRoutedAt: at })
      .where(
        and(
          eq(channelPartnerPriorities.channelId, channelId),
          eq(channelPartnerPriorities.partnerId, partnerId),
        ),
      );
  }

  /** Список партнёров канала в порядке приоритета. */
  async listPartnerPriorities(channelId: ChannelId): Promise<PartnerPriorityRow[]> {
    return this.db
      .select()
      .from(channelPartnerPriorities)
      .where(eq(channelPartnerPriorities.channelId, channelId))
      .orderBy(asc(channelPartnerPriorities.priority));
  }

  /**
   * Заменяет список партнёров канала целиком.
   *
   * Именно замена, а не правка по одному: список — это порядок, и менять его частями
   * значит на время оставлять канал с порядком, которого клиент не задавал.
   * Одной транзакцией по той же причине.
   */
  async replacePartnerPriorities(
    channelId: ChannelId,
    entries: readonly { partnerId: PartnerId; priority: number }[],
  ): Promise<PartnerPriorityRow[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(channelPartnerPriorities)
        .where(eq(channelPartnerPriorities.channelId, channelId));

      if (entries.length === 0) return [];

      return tx
        .insert(channelPartnerPriorities)
        .values(
          entries.map((entry) => ({
            id: newId<'channelPartnerPriority'>(),
            channelId,
            partnerId: entry.partnerId,
            priority: entry.priority,
          })),
        )
        .returning();
    });
  }

  // --- Покрытие партнёра по регионам (ADR-0022) ---------------------------------

  /** Регионы партнёра в том виде, в котором он их ввёл. */
  async listCoverage(partnerId: PartnerId): Promise<PartnerCoverageRow[]> {
    return this.db
      .select()
      .from(partnerCoverage)
      .where(eq(partnerCoverage.partnerId, partnerId))
      .orderBy(asc(partnerCoverage.region));
  }

  /**
   * Заменяет список регионов партнёра целиком.
   *
   * Замена, а не правка по одному: пустой список означает «все регионы», и промежуточное
   * состояние из одной строки — это не «список ещё не дописан», а работающее ограничение,
   * которого партнёр не задавал. Одной транзакцией по той же причине.
   */
  async replaceCoverage(
    partnerId: PartnerId,
    entries: readonly { region: string; regionKey: string }[],
  ): Promise<PartnerCoverageRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.delete(partnerCoverage).where(eq(partnerCoverage.partnerId, partnerId));

      if (entries.length === 0) return [];

      return tx
        .insert(partnerCoverage)
        .values(
          entries.map((entry) => ({
            id: newId<'partnerCoverage'>(),
            partnerId,
            region: entry.region,
            regionKey: entry.regionKey,
          })),
        )
        .returning();
    });
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

  /**
   * Канал, годный для маршрутизации, по его идентификатору.
   *
   * Состояние клиента проверяется тем же запросом: клиент, которому закрыли доступ,
   * не должен звонить, а отдельная проверка после чтения канала разъезжается с ним
   * ровно в тот момент, когда доступ закрывают.
   */
  async findRoutableChannel(
    id: ChannelId,
  ): Promise<{ channel: ChannelRow; clientId: Id<'client'> } | undefined> {
    const [row] = await this.db
      .select({ channel: channels })
      .from(channels)
      .innerJoin(clients, eq(clients.id, channels.clientId))
      .where(and(eq(channels.id, id), eq(channels.status, 'active'), eq(clients.status, 'active')));
    return row === undefined ? undefined : { channel: row.channel, clientId: row.channel.clientId };
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

/**
 * Условие «партнёр этой SIM принимает вызовы в этот регион» ([ADR-0022](../../../../../docs/adr/0022-pokrytie-regionov.md)).
 *
 * `bool_or` по пустому множеству — `NULL`, поэтому `coalesce` выражает правило «списка нет →
 * подходит любой регион» ровно так, как оно записано словами. Сравнение `is not distinct from`,
 * а не `=`: у неизвестного региона `=` дало бы `NULL` на каждой строке, снова `NULL` после
 * `bool_or` — и партнёр со списком принял бы вызов, регион которого неизвестен.
 *
 * Ключ считается **той же функцией**, что и при записи покрытия: две разные нормализации —
 * это гарантированное расхождение, которого не поймает ни один тест ниже сквозного.
 */
function coversRegion(region: string | null): SQL {
  const normalized = region === null ? '' : normalizeRegion(region);
  // Пустой ключ — это не регион: строка вроде «область» ничего не называет, и считать
  // её известным регионом значит выдать маршрут по несуществующему покрытию.
  const key = normalized === '' ? null : normalized;

  return sql`coalesce((select bool_or(${partnerCoverage.regionKey} is not distinct from ${key}::text) from ${partnerCoverage} where ${partnerCoverage.partnerId} = ${simCards.partnerId}), true)`;
}
