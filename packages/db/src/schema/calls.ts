/**
 * Вызовы и резервы средств (ADR-0010).
 *
 * **Вызов записывается всегда — включая отказ.** Отказ маршрутизации это тоже вызов,
 * со статусом `failed` и причиной: иначе на вопрос «почему у клиента не звонит»
 * отвечать нечем, в журнале ничего не остаётся.
 *
 * По открытым вызовам считается одновременность на SIM. Счёт по таблице, а не счётчиком
 * в стороннем хранилище, выбран намеренно: счётчик расходится при сбое и требует сверки,
 * а таблица вызовов — источник истины, и расходиться ей не с чем.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CALL_FAILURE_REASONS,
  CALL_STATUSES,
  RESERVATION_STATUSES,
  type CallFailureReason,
  type CallStatus,
  type ReservationStatus,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients } from './billing.js';
import { operators } from './catalog.js';
import { nodes } from './nodes.js';
import { channels, gateways, simCards } from './telephony.js';

export const calls = pgTable(
  'calls',
  {
    id: primaryId<'call'>(),

    /**
     * Идентификатор вызова на узле (`Unique-ID` FreeSWITCH).
     *
     * Он же ключ идемпотентности CDR и сквозной идентификатор в логах. Уникален:
     * узел может прислать один и тот же CDR повторно — это штатный режим, а не сбой.
     */
    externalId: text().notNull(),

    /** Канал клиента — линия, с которой пришёл вызов. */
    channelId: idRef<'channel'>()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),

    /** Узел, обслуживающий вызов. */
    nodeId: idRef<'node'>()
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),

    /**
     * Номер назначения в нормализованном виде — **кроме отказа `destination_invalid`**:
     * там лежат цифры набранного, потому что канонического вида у него и не получилось
     * ([ADR-0042](../../../../docs/adr/0042-diagnoz-po-nerazobrannomu-nomeru.md)).
     * Ограничение формата в базе исключение называет прямо: у `destination_invalid`
     * допускаются только цифры, у всего остального — одиннадцать, начиная с семёрки.
     * В коде то же держит тип `CallDestination`: произвольная строка сюда
     * не присваивается, только прошедшая разбор.
     *
     * Персональные данные абонента: в логах маскируется, в клиентский контур уходит
     * только своему клиенту.
     */
    destination: text().notNull(),

    /** Оператор назначения по ответу резолвера. Пусто, если до определения не дошло. */
    operatorId: idRef<'operator'>().references(() => operators.id, { onDelete: 'restrict' }),

    /** Регион назначения по ответу резолвера. Вместе с оператором задаёт направление. */
    region: text(),

    /** Выбранная SIM и её шлюз. Пусто у отказа: выбирать было не из чего. */
    simCardId: idRef<'simCard'>().references(() => simCards.id, { onDelete: 'restrict' }),
    gatewayId: idRef<'gateway'>().references(() => gateways.id, { onDelete: 'restrict' }),

    status: text().$type<CallStatus>().notNull().default('routing'),

    /** Причина отказа. Заполнена ровно у несостоявшихся вызовов. */
    failureReason: text().$type<CallFailureReason>(),

    startedAt: timestamptz().notNull().defaultNow(),
    answeredAt: timestamptz(),
    endedAt: timestamptz(),

    /** Фактическая длительность разговора в секундах. Пусто, пока вызов не завершён. */
    durationSeconds: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('calls_status_check', oneOf(t.status, CALL_STATUSES)),
    check(
      'calls_failure_reason_check',
      sql`${t.failureReason} is null or ${t.failureReason} in ${sql.raw(`(${CALL_FAILURE_REASONS.map((value) => `'${value}'`).join(', ')})`)}`,
    ),
    // Причина отказа у состоявшегося вызова означала бы, что кто-то перепутал поля,
    // и по такому вызову разбор пошёл бы по ложному следу.
    check(
      'calls_failure_reason_matches_status',
      sql`${t.failureReason} is null or ${t.status} = 'failed'`,
    ),
    check(
      'calls_duration_non_negative',
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
    // Канонический номер — и ровно одно исключение, названное здесь же: отказ
    // `destination_invalid`, у которого канонического вида и не получилось
    // (ADR-0042). Там допускаются только цифры: звёздочки и решётки из набора
    // в это поле не попадают, оттуда оно уходит в отчёты и клиентский контур.
    check(
      'calls_destination_format',
      sql`case when ${t.failureReason} = 'destination_invalid'
            then ${t.destination} ~ '^[0-9]*$'
            else ${t.destination} ~ '^7[0-9]{10}$'
          end`,
    ),
    uniqueIndex('calls_external_id_key').on(t.externalId),
    // Горячий путь: сколько вызовов сейчас открыто на этой SIM.
    index('calls_sim_status_idx').on(t.simCardId, t.status),
    index('calls_channel_started_idx').on(t.channelId, t.startedAt),
    index('calls_status_started_idx').on(t.status, t.startedAt),
    // Разбор «почему не звонит»: свежие вызовы по всей площадке, без отбора по статусу.
    // Составной индекс выше для такого порядка не годится — он начинается со статуса,
    // и запрос без него уходит в полное чтение самой большой таблицы системы с сортировкой.
    index('calls_started_idx').on(t.startedAt),
  ],
);

/**
 * Резерв средств под вызов.
 *
 * **Резерв не меняет остаток и не создаёт проводок.** Он ограничивает *доступную* сумму:
 * доступно = остаток + овердрафт − сумма действующих резервов. Так инвариант «баланс
 * не уходит ниже разрешённого овердрафта» соблюдается до звонка, а журнал проводок
 * остаётся журналом реальных движений денег.
 *
 * Обратное решение — проводить резерв в журнал — давало бы на каждый несостоявшийся
 * вызов пару записей туда и обратно: проводки неизменяемы, освободить их можно только
 * встречной. Журнал распух бы шумом, в котором тонут настоящие списания.
 */
export const reservations = pgTable(
  'reservations',
  {
    id: primaryId<'reservation'>(),

    callId: idRef<'call'>()
      .notNull()
      .references(() => calls.id, { onDelete: 'restrict' }),

    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),

    /** Максимальная стоимость вызова: цена разговора предельной длительности. */
    amount: money().notNull(),

    status: text().$type<ReservationStatus>().notNull().default('held'),

    /**
     * Когда резерв освобождается сам.
     *
     * Потерянный CDR не должен замораживать остаток клиента навсегда: это не потеря
     * денег, но клиент перестаёт звонить, а причина не видна ниоткуда.
     */
    expiresAt: timestamptz().notNull(),

    /** Момент закрытия резерва. Заполнен ровно у закрытых. */
    settledAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('reservations_status_check', oneOf(t.status, RESERVATION_STATUSES)),
    check('reservations_amount_positive', sql`${t.amount} > 0`),
    check(
      'reservations_settled_at_matches_status',
      sql`(${t.status} = 'held' and ${t.settledAt} is null) or (${t.status} <> 'held' and ${t.settledAt} is not null)`,
    ),
    // Один вызов — один резерв. Второй означал бы, что деньги придержаны дважды
    // за одно и то же, и доступная сумма занижена вдвое.
    uniqueIndex('reservations_call_key').on(t.callId),
    // Горячий путь: сумма действующих резервов клиента при проверке доступного остатка.
    index('reservations_client_status_idx').on(t.clientId, t.status),
    // Отбор просроченных фоновой задачей.
    index('reservations_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'held'`),
  ],
);
