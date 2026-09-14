/**
 * Запросы к шлюзам партнёров и каналам клиентов (ADR-0009).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { orderByText, toDatabaseError, type Database, type Executor } from '@zvonix/db';
import {
  channelAllowedOperators,
  channelPartnerPriorities,
  channels,
  clients,
  gatewayPorts,
  gateways,
  partnerCoverage,
  partners,
  simCards,
  sipTrunks,
} from '@zvonix/db/schema';
import {
  newId,
  regionKeysOf,
  USABLE_PORT_STATES,
  USABLE_SIM_STATUSES,
  type ChannelStatus,
  type GatewayPortState,
  type GatewayState,
  type GatewayStatus,
  type GatewayType,
  type Id,
  type Msisdn,
  type SimStatus,
  type TerminationKind,
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
export type SipTrunkRow = typeof sipTrunks.$inferSelect;
export type PartnerPriorityRow = typeof channelPartnerPriorities.$inferSelect;
export type PartnerCoverageRow = typeof partnerCoverage.$inferSelect;
export type AllowedOperatorRow = typeof channelAllowedOperators.$inferSelect;
export type PartnerId = Id<'partner'>;

/**
 * Состояние шлюза из строки.
 *
 * В строке две независимые колонки, и тип этого не выражает. Согласованность держит
 * CHECK `gateways_suspended_by_matches_status`, так что несогласованная строка — поломка
 * базы, а не состояние, и разбирать её как одно из состояний нельзя
 * ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
 */
export function gatewayStateOf(row: GatewayRow): GatewayState {
  if (row.status === 'suspended') {
    if (row.suspendedBy === null) {
      throw new Error(`Шлюз ${row.id} выключен без источника: нарушен CHECK схемы`);
    }
    return { status: 'suspended', suspendedBy: row.suspendedBy };
  }
  return { status: row.status, suspendedBy: null };
}

/** Исполнитель запроса: пул или транзакция. */
// Тип объявлен в `@zvonix/db` и переэкспортируется отсюда: вызывающий берёт его
// там же, где метод, а определение остаётся одно на весь проект.
export type { Executor };

/**
 * Кандидат на терминацию через SIP-транк
 * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Ни SIM, ни порта: ёмкость меряется числом одновременных вызовов на самом транке,
 * а набор идёт не через зарегистрированного у нас пользователя, а через исходящий
 * sofia-gateway на узле.
 */
export interface TrunkCandidate {
  readonly kind: 'sip';
  readonly trunk: SipTrunkRow;
  readonly gateway: GatewayRow;
  readonly priority: number | null;
  readonly lastRoutedAt: Date | null;
}

/** Кандидат на терминацию любого рода. Ветвление — по `kind`. */
export type TerminationCandidate = SimCandidate | TrunkCandidate;

/**
 * Кандидат на терминацию вызова: годная SIM нужного оператора вместе с портом,
 * в котором она стоит, и шлюзом, к которому этот порт относится.
 */
export interface SimCandidate {
  /** Размечающее поле: у транка своя ветвь во всём, что касается ёмкости и набора. */
  readonly kind: 'sim';
  readonly sim: SimCardRow;
  readonly port: GatewayPortRow;
  readonly gateway: GatewayRow;

  /**
   * Приоритет предложения в канале и давность его последнего вызова.
   *
   * Отдаются наружу, потому что окончательный порядок складывается уже **после**
   * запроса: между приоритетом и давностью встаёт цена
   * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)),
   * а она берётся у чужого модуля и одним запросом на всех кандидатов сразу.
   *
   * Пусто — предложению приоритет не задан; такое идёт после всех названных.
   */
  readonly priority: number | null;
  readonly lastRoutedAt: Date | null;
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

  /**
   * Списание шлюза вместе с освобождением его портов — одной транзакцией.
   *
   * Порознь нельзя: списанный шлюз с картой в порту — это карта, которую партнёр
   * не может ни вынуть (портов списанного шлюза в кабинете нет), ни списать
   * («стоит в порту»), ни поставить в другой порт («уже стоит в другом»). Тупик
   * закрывается тем, что порта после списания не существует и держать в нём нечего.
   *
   * Отдаётся то, что в портах стояло: без этого журнал не отличит снятие карты
   * от того, что её там и не было.
   *
   * **Сначала состояние, потом порты.** Смена состояния идёт условием на прежнее
   * и при несовпадении не трогает ничего. В обратном порядке гонка «партнёр списывает —
   * администратор запирает» вынула бы карты у шлюза, который так и не списался:
   * `return` внутри транзакции её не откатывает, а фиксирует.
   */
  async retireGatewayFreeingPorts(
    id: GatewayId,
    from: GatewayState,
  ): Promise<
    | {
        gateway: GatewayRow;
        freed: { portId: GatewayPortId; simCardId: SimCardId }[];
      }
    | undefined
  > {
    try {
      return await this.db.transaction(async (tx) => {
        const gateway = await this.transitionGateway(
          id,
          from,
          { status: 'retired', suspendedBy: null },
          tx,
        );
        if (gateway === undefined) return undefined;

        const occupied = await tx
          .select({ id: gatewayPorts.id, simCardId: gatewayPorts.simCardId })
          .from(gatewayPorts)
          .where(and(eq(gatewayPorts.gatewayId, id), isNotNull(gatewayPorts.simCardId)));

        if (occupied.length > 0) {
          await tx
            .update(gatewayPorts)
            .set({ simCardId: null })
            .where(and(eq(gatewayPorts.gatewayId, id), isNotNull(gatewayPorts.simCardId)));
        }

        return {
          gateway,
          freed: occupied.flatMap((port) =>
            port.simCardId === null ? [] : [{ portId: port.id, simCardId: port.simCardId }],
          ),
        };
      });
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
        ? await query.orderBy(orderByText(gateways.name))
        : await query.where(eq(gateways.partnerId, partnerId)).orderBy(orderByText(gateways.name));
    return rows;
  }

  /**
   * Смена состояния шлюза — только из ожидаемого
   * ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   *
   * Условие и на состояние, и на источник отключения: решение, принятое между чтением
   * и записью, не затирается. Администратор запер шлюз, пока партнёр его включал;
   * порог отключил, пока администратор разбирался, — не совпало, `undefined`.
   */
  async transitionGateway(
    id: GatewayId,
    from: GatewayState,
    to: GatewayState,
    executor: Executor = this.db,
  ): Promise<GatewayRow | undefined> {
    const [row] = await executor
      .update(gateways)
      .set({ status: to.status, suspendedBy: to.suspendedBy })
      .where(
        and(
          eq(gateways.id, id),
          eq(gateways.status, from.status),
          from.suspendedBy === null
            ? isNull(gateways.suspendedBy)
            : eq(gateways.suspendedBy, from.suspendedBy),
        ),
      )
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
        ? await query.orderBy(orderByText(channels.name))
        : await query.where(eq(channels.clientId, clientId)).orderBy(orderByText(channels.name));
    return rows;
  }

  /**
   * Правит настройки канала: название, требование записи, номер для показа.
   *
   * Учётных данных не касается — их меняет только перевыпуск, и смешивать эти два
   * действия нельзя: правка названия не должна ронять регистрацию клиентской АТС.
   */
  async updateChannel(
    id: ChannelId,
    changes: { name?: string; recordingRequired?: boolean; callerId?: string | null },
  ): Promise<ChannelRow | undefined> {
    try {
      const [row] = await this.db
        .update(channels)
        .set(changes)
        .where(eq(channels.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async replaceChannelCredentials(
    id: ChannelId,
    sipUsername: string,
    a1Hash: string,
  ): Promise<ChannelRow | undefined> {
    try {
      const [row] = await this.db
        .update(channels)
        .set({ sipUsername, a1Hash })
        .where(eq(channels.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
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
          // Транк в каталоге не значится: к нему регистрируемся мы, а не он к нам,
          // и проверять digest нечего. Его имя узел получает отдельно — списком
          // исходящих sofia-gateway (ADR-0039).
          ne(gateways.type, 'sip_trunk'),
        ),
      );
    return row?.gateway;
  }

  // --- SIP-транки (ADR-0039) ---------------------------------------------------

  /**
   * Заводит транк: шлюз и его подробности — **одной транзакцией**.
   *
   * Порознь они дали бы шлюз без подробностей, то есть транк, который нечем набрать,
   * и при этом годный по всем прочим признакам.
   */
  async createTrunk(
    gateway: {
      partnerId: Id<'partner'>;
      name: string;
      sipUsername: string;
      nodeId: Id<'node'>;
    },
    trunk: {
      proxyHost: string;
      registersOutbound: boolean;
      outboundUsername: string | null;
      outboundSecret: string | null;
      maxConcurrentCalls: number;
    },
  ): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(gateways)
          .values({
            id: newId<'gateway'>(),
            partnerId: gateway.partnerId,
            name: gateway.name,
            type: 'sip_trunk',
            status: 'pending',
            sipUsername: gateway.sipUsername,
            // К транку регистрируемся мы, а не он к нам: проверять digest нечего.
            a1Hash: null,
            nodeId: gateway.nodeId,
            model: null,
            portCount: 0,
          })
          .returning();
        if (created === undefined) throw new Error('Вставка шлюза не вернула строку');

        const [details] = await tx
          .insert(sipTrunks)
          .values({ gatewayId: created.id, ...trunk })
          .returning();
        if (details === undefined) throw new Error('Вставка транка не вернула строку');

        return { gateway: created, trunk: details };
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findTrunk(
    gatewayId: GatewayId,
  ): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow } | undefined> {
    const [row] = await this.db
      .select({ gateway: gateways, trunk: sipTrunks })
      .from(sipTrunks)
      .innerJoin(gateways, eq(gateways.id, sipTrunks.gatewayId))
      .where(eq(sipTrunks.gatewayId, gatewayId));
    return row;
  }

  async listTrunks(partnerId?: PartnerId): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }[]> {
    return this.db
      .select({ gateway: gateways, trunk: sipTrunks })
      .from(sipTrunks)
      .innerJoin(gateways, eq(gateways.id, sipTrunks.gatewayId))
      .where(partnerId === undefined ? undefined : eq(gateways.partnerId, partnerId))
      .orderBy(orderByText(gateways.name));
  }

  async updateTrunk(
    gatewayId: GatewayId,
    changes: Partial<{
      proxyHost: string;
      registersOutbound: boolean;
      outboundUsername: string | null;
      outboundSecret: string | null;
      maxConcurrentCalls: number;
    }>,
  ): Promise<SipTrunkRow | undefined> {
    try {
      const [row] = await this.db
        .update(sipTrunks)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(sipTrunks.gatewayId, gatewayId))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Транки, годные принять вызов на этом узле.
   *
   * **Отбор по узлу обязателен**, в отличие от SIM: к провайдеру регистрируемся мы,
   * и регистрация принадлежит конкретному узлу. Отправить вызов на транк, поднятый
   * соседним узлом, значит отправить его в никуда.
   *
   * Оператор здесь не проверяется: у транка нет «своей сети», и куда он звонит,
   * задаёт **прайс партнёра** — цена по направлению и есть его объявление
   * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
   * Кандидатов без цены отсеивает порядок перебора (ADR-0040).
   */
  async findTrunkCandidates(
    nodeId: Id<'node'>,
    options: { channelId?: ChannelId; region?: string | null } = {},
  ): Promise<TrunkCandidate[]> {
    const { channelId } = options;
    const conditions: SQL[] = [
      eq(gateways.type, 'sip_trunk'),
      eq(gateways.status, 'active'),
      eq(partners.status, 'verified'),
      eq(gateways.nodeId, nodeId),
    ];
    if (options.region !== undefined) {
      conditions.push(coversRegion(options.region, gateways.partnerId));
    }
    if (channelId !== undefined) {
      conditions.push(
        sql`(${channelPartnerPriorities.id} is not null or not exists (select 1 from ${channelPartnerPriorities} as configured where configured.channel_id = ${channelId}))`,
      );
    }

    return this.db
      .select({
        kind: sql<'sip'>`'sip'`,
        trunk: sipTrunks,
        gateway: gateways,
        priority: channelPartnerPriorities.priority,
        lastRoutedAt: channelPartnerPriorities.lastRoutedAt,
      })
      .from(sipTrunks)
      .innerJoin(gateways, eq(gateways.id, sipTrunks.gatewayId))
      .innerJoin(partners, eq(partners.id, gateways.partnerId))
      .leftJoin(
        channelPartnerPriorities,
        channelId === undefined
          ? sql`false`
          : and(
              eq(channelPartnerPriorities.channelId, channelId),
              eq(channelPartnerPriorities.partnerId, gateways.partnerId),
              eq(channelPartnerPriorities.terminationKind, 'sip'),
            ),
      )
      .where(and(...conditions))
      .orderBy(
        sql`coalesce(${channelPartnerPriorities.priority}, 2147483647) asc`,
        sql`${channelPartnerPriorities.lastRoutedAt} asc nulls first`,
        orderByText(gateways.name),
      );
  }

  /**
   * Кандидат по уже выбранному транку — для повтора запроса по тому же вызову.
   *
   * Состояния здесь **не** проверяются, ровно как у `findCandidateBySim`: маршрут уже
   * выдан, канал транка занят, и повтор обязан вернуть то же решение.
   */
  async findTrunkCandidate(gatewayId: GatewayId): Promise<TrunkCandidate | undefined> {
    const [row] = await this.db
      .select({ trunk: sipTrunks, gateway: gateways })
      .from(sipTrunks)
      .innerJoin(gateways, eq(gateways.id, sipTrunks.gatewayId))
      .where(eq(sipTrunks.gatewayId, gatewayId));

    return row === undefined
      ? undefined
      : { kind: 'sip', ...row, priority: null, lastRoutedAt: null };
  }

  /**
   * Транки, которые этот узел обязан поднять у провайдеров.
   *
   * Отдаются только действующие и только свои: узел не должен регистрироваться
   * за чужой узел, а отключённый партнёр перестаёт быть поднятым при следующем же
   * обновлении конфигурации — тем же способом, каким его шлюз перестаёт находиться
   * в каталоге.
   */
  async listNodeTrunks(nodeId: Id<'node'>): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }[]> {
    return this.db
      .select({ gateway: gateways, trunk: sipTrunks })
      .from(sipTrunks)
      .innerJoin(gateways, eq(gateways.id, sipTrunks.gatewayId))
      .innerJoin(partners, eq(partners.id, gateways.partnerId))
      .where(
        and(
          eq(gateways.nodeId, nodeId),
          eq(gateways.status, 'active'),
          eq(partners.status, 'verified'),
        ),
      )
      .orderBy(orderByText(gateways.name));
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

  /**
   * Сколько шлюзов и карт у партнёра — для предела на собственное заведение
   * ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
   *
   * Счётчиком, а не длиной списка: у партнёра их бывают сотни, и тянуть все строки
   * ради одного числа значит читать таблицу на каждое заведение.
   * Списанное не считается: предел про то, что стоит у партнёра сейчас.
   */
  async countGateways(partnerId: Id<'partner'>): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(gateways)
      .where(and(eq(gateways.partnerId, partnerId), ne(gateways.status, 'retired')));
    return row?.value ?? 0;
  }

  async countSims(partnerId: Id<'partner'>): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(simCards)
      .where(and(eq(simCards.partnerId, partnerId), ne(simCards.status, 'retired')));
    return row?.value ?? 0;
  }

  /**
   * Есть ли у партнёра карта с этим номером, которую держит площадка: `throttled`
   * или `blocked`. Заведение того же номера заново обходило бы её решение — новая
   * запись пришла бы без него ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   */
  async hasHeldSim(partnerId: Id<'partner'>, msisdn: Msisdn): Promise<boolean> {
    const [row] = await this.db
      .select({ value: count() })
      .from(simCards)
      .where(
        and(
          eq(simCards.partnerId, partnerId),
          eq(simCards.msisdn, msisdn),
          inArray(simCards.status, ['throttled', 'blocked']),
        ),
      );
    return (row?.value ?? 0) > 0;
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

  /**
   * Смена состояния карты только из ожидаемого — для автомата порога.
   *
   * Блокировку, поставленную администратором между отбором и записью, автомат
   * не перезаписывает своим `throttled` ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   */
  async transitionSimStatus(
    id: SimCardId,
    from: SimStatus,
    to: SimStatus,
  ): Promise<SimCardRow | undefined> {
    const [row] = await this.db
      .update(simCards)
      .set({ status: to })
      .where(and(eq(simCards.id, id), eq(simCards.status, from)))
      .returning();
    return row;
  }

  /**
   * Отметка «оператор карты подтверждён источником».
   *
   * Ставится при заведении, а если источник тогда промолчал — при первой удавшейся
   * попытке включить карту ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
   */
  async confirmSimOperator(id: SimCardId, at: Date): Promise<SimCardRow | undefined> {
    const [row] = await this.db
      .update(simCards)
      .set({ operatorConfirmedAt: at })
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

  /**
   * В каком порту стоит эта SIM.
   *
   * Нужно ради внятного отказа: «одна SIM в одном порту» держит частичный уникальный
   * индекс, но он отвечает «такая запись уже существует» — а человеку надо знать,
   * что SIM занята и каким портом.
   */
  async findPortBySim(simCardId: SimCardId): Promise<GatewayPortRow | undefined> {
    const [row] = await this.db
      .select()
      .from(gatewayPorts)
      .where(eq(gatewayPorts.simCardId, simCardId));
    return row;
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
   * Все порты партнёра одним запросом.
   *
   * Не `listPorts` по каждому шлюзу: у партнёра их бывают десятки, и запрос на шлюз
   * превратил бы один экран кабинета в столько же обращений к базе. Порядок — как
   * в кабинете: шлюз за шлюзом, порты по номеру.
   */
  async listPartnerPorts(partnerId: Id<'partner'>): Promise<GatewayPortRow[]> {
    return this.db
      .select({ port: gatewayPorts })
      .from(gatewayPorts)
      .innerJoin(gateways, eq(gateways.id, gatewayPorts.gatewayId))
      .where(eq(gateways.partnerId, partnerId))
      .orderBy(orderByText(gateways.name), asc(gatewayPorts.portNumber))
      .then((rows) => rows.map((row) => row.port));
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

      /**
       * Узел, принявший вызов. Задан — кандидатами становятся только шлюзы,
       * зарегистрированные **на нём**: диалплан набирает их как зарегистрированных
       * пользователей, и с чужого узла такой записи не существует.
       *
       * Без поля отбор идёт по всей площадке — так спрашивает разбор
       * «какие SIM вообще подходят», где узел ещё не при чём.
       */
      nodeId?: Id<'node'>;
    } = {},
  ): Promise<SimCandidate[]> {
    const channelId = options.channelId;

    const conditions = [
      eq(simCards.operatorId, operatorId),
      inArray(simCards.status, [...USABLE_SIM_STATUSES]),
      inArray(gatewayPorts.state, [...USABLE_PORT_STATES]),
      eq(gateways.status, 'active'),
      eq(partners.status, 'verified'),
    ];
    if (options.nodeId !== undefined) {
      // Диалплан обращается к шлюзу как к **зарегистрированному пользователю**
      // (`user/gw-…@realm`), а регистрации живут на том узле, куда шлюз пришёл.
      // Кандидат с другого узла — маршрут, по которому нельзя набрать; кандидат
      // без регистрации вовсе — тем более.
      conditions.push(eq(gateways.nodeId, options.nodeId));
    }
    if (options.excludeRecordingIncapable === true) {
      conditions.push(ne(gateways.type, 'android'));
    }
    if (options.region !== undefined) {
      conditions.push(coversRegion(options.region));
    }
    if (channelId !== undefined) {
      // Спрашивается наличие строк **у канала**, а не наличие приоритета у кандидата:
      // клиент мог перечислить партнёров, у которых сейчас нет свободной SIM, и тогда
      // среди кандидатов приоритетов не окажется вовсе. Считать это «список не заполнен»
      // значит позвонить через партнёра, которого клиент из списка исключил.
      //
      // Тем же запросом, а не отдельным чтением до него: два чтения разъезжаются ровно
      // в тот момент, когда клиент правит список, и вызов уходит по порядку, которого
      // уже нет. Подзапрос не зависит от строки и вычисляется планировщиком один раз.
      conditions.push(
        sql`(${channelPartnerPriorities.id} is not null or not exists (select 1 from ${channelPartnerPriorities} as configured where configured.channel_id = ${channelId}))`,
      );
    }

    return this.db
      .select({
        kind: sql<'sim'>`'sim'`,
        sim: simCards,
        port: gatewayPorts,
        gateway: gateways,
        priority: channelPartnerPriorities.priority,
        lastRoutedAt: channelPartnerPriorities.lastRoutedAt,
      })
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
              // Единица приоритета — предложение, то есть партнёр вместе со способом
              // терминации (ADR-0040). Здесь отбираются SIM, поэтому способ известен.
              eq(channelPartnerPriorities.terminationKind, 'sim'),
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

  /**
   * Кандидат по уже выбранной SIM — для повтора запроса по тому же вызову.
   *
   * Состояния SIM, порта, шлюза и партнёра здесь **не** проверяются намеренно: маршрут
   * уже выдан, место на SIM занято, и повтор обязан вернуть то же решение. Проверить
   * их заново значит превратить повтор в новое решение — а вызов при этом идёт,
   * и деньги под него придержаны.
   */
  async findCandidateBySim(simCardId: SimCardId): Promise<SimCandidate | undefined> {
    const [row] = await this.db
      .select({ sim: simCards, port: gatewayPorts, gateway: gateways })
      .from(simCards)
      .innerJoin(gatewayPorts, eq(gatewayPorts.simCardId, simCards.id))
      .innerJoin(gateways, eq(gateways.id, gatewayPorts.gatewayId))
      .where(eq(simCards.id, simCardId));

    // Порядок здесь не нужен: маршрут уже выдан, выбирать не из чего. Заполняется,
    // чтобы вид кандидата был один на оба пути и вызывающему не приходилось помнить,
    // какой из них отдаёт неполную строку.
    return row === undefined
      ? undefined
      : { kind: 'sim', ...row, priority: null, lastRoutedAt: null };
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
    terminationKind: TerminationKind,
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
          // Очередь стоит из предложений, а не из партнёров: отметить партнёра целиком
          // значило бы отправить в конец очереди и то предложение, которым не звонили.
          eq(channelPartnerPriorities.terminationKind, terminationKind),
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
    entries: readonly {
      partnerId: PartnerId;
      terminationKind: TerminationKind;
      priority: number;
    }[],
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
            terminationKind: entry.terminationKind,
            priority: entry.priority,
          })),
        )
        .returning();
    });
  }

  // --- Разрешённые операторы канала (ADR-0025) ----------------------------------

  /**
   * Разрешён ли каналу вызов на этого оператора.
   *
   * Спрашивается сразу и наличие списка, и попадание в него: два отдельных чтения
   * разъезжались бы между собой ровно в тот момент, когда клиент правит список.
   * Пустой список означает «все операторы» — иначе новый канал не смог бы позвонить,
   * пока кто-то его не заполнит.
   */
  async isOperatorAllowed(channelId: ChannelId, operatorId: Id<'operator'>): Promise<boolean> {
    const [row] = await this.db
      .select({
        // `bool_or` по пустому множеству — `NULL`, и это ровно то, что нужно различить:
        // «список не заведён» и «заведён, оператора в нём нет» — разные ответы.
        configured: sql<boolean | null>`bool_or(true)`,
        allowed: sql<
          boolean | null
        >`bool_or(${channelAllowedOperators.operatorId} = ${operatorId})`,
      })
      .from(channelAllowedOperators)
      .where(eq(channelAllowedOperators.channelId, channelId));

    if (row === undefined || row.configured !== true) return true;
    return row.allowed === true;
  }

  async listAllowedOperators(channelId: ChannelId): Promise<AllowedOperatorRow[]> {
    return this.db
      .select()
      .from(channelAllowedOperators)
      .where(eq(channelAllowedOperators.channelId, channelId))
      .orderBy(asc(channelAllowedOperators.operatorId));
  }

  /**
   * Заменяет список операторов канала целиком.
   *
   * Замена, а не правка по одному: пустой список означает «все операторы», и дописать
   * к нему один оператор значило бы не расширение, а внезапное ограничение до одного.
   */
  async replaceAllowedOperators(
    channelId: ChannelId,
    operatorIds: readonly Id<'operator'>[],
  ): Promise<AllowedOperatorRow[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(channelAllowedOperators)
        .where(eq(channelAllowedOperators.channelId, channelId));

      if (operatorIds.length === 0) return [];

      return tx
        .insert(channelAllowedOperators)
        .values(
          operatorIds.map((operatorId) => ({
            id: newId<'channelAllowedOperator'>(),
            channelId,
            operatorId,
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
 * подходит любой регион» ровно так, как оно записано словами.
 *
 * Регион вызова — **набор субъектов**, а не один
 * ([ADR-0033](../../../../../docs/adr/0033-region-eto-mnozhestvo.md)): каждый седьмой
 * диапазон плана нумерации выделен на два, и в источнике они перечислены в произвольном
 * порядке. Партнёр подходит, если объявил **хотя бы один** из них, — отсюда `= any`.
 *
 * Неизвестный регион даёт пустой набор, а `= any('{}')` ложно на каждой строке: партнёр
 * со списком такой вызов не принимает, партнёр без списка принимает. Это правило 2
 * ADR-0022, и оно не изменилось.
 *
 * Набор считается **той же функцией**, что и ключ при записи покрытия: две разные
 * нормализации — гарантированное расхождение, которого не поймает ни один тест
 * ниже сквозного.
 */
function coversRegion(
  region: string | null,
  partnerColumn: SQL | AnyColumn = simCards.partnerId,
): SQL {
  const keys = regionKeysOf(region);
  // Массив собирается поэлементно, а не передаётся одним параметром: драйвер отдал бы
  // массив строкой, которую PostgreSQL не считает литералом массива. Пустой набор —
  // отдельной ветвью: `array[]` без элементов не выражается.
  const wanted =
    keys.length === 0
      ? sql`'{}'::text[]`
      : sql`array[${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]`;

  return sql`coalesce((select bool_or(${partnerCoverage.regionKey} = any(${wanted})) from ${partnerCoverage} where ${partnerCoverage.partnerId} = ${partnerColumn}), true)`;
}
