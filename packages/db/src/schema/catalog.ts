/**
 * Справочник операторов и определение оператора номера (ADR-0013).
 *
 * Три таблицы отвечают на три разных вопроса, и путать их дорого:
 *   `operators`               — кто такой оператор, какая у него сеть и не MVNO ли он;
 *   `numbering_plan_ranges`   — кому **выделен** диапазон (из бесплатных файлов);
 *   `number_resolutions`      — кто **обслуживает** конкретный номер сейчас.
 *
 * Для перенесённого номера второй и третий ответы различаются, и именно поэтому
 * план нумерации не считается подтверждением оператора.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  NUMBERING_PLAN_SOURCES,
  RESOLUTION_SOURCES,
  type NumberingPlanSource,
  type ResolutionSource,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';

export const operators = pgTable(
  'operators',
  {
    id: primaryId<'operator'>(),

    /** Каноническое название. Все прочие написания — в `operator_aliases`. */
    name: text().notNull(),

    /** ИНН. По нему сливаются записи двух источников плана нумерации. */
    inn: text(),

    /**
     * Код сети (MNC). Есть только у операторов с собственной сетью: у MVNO своей нет,
     * и для них важен MNC хозяина сети, а не собственный.
     */
    mnc: text(),

    /**
     * Виртуальный оператор: своей сети нет, трафик идёт по чужой.
     *
     * Отдельный признак нужен потому, что абоненты MVNO — другое юридическое лицо,
     * и оператор-хозяин сети вправе считать звонки на них внесетевыми, даже когда
     * физически они идут по его же сети. Это вопрос условий тарифа, а не техники.
     */
    isMvno: boolean().notNull().default(false),

    /**
     * Чья сеть обслуживает MVNO. У операторов с собственной сетью пусто.
     *
     * Ссылка на эту же таблицу, поэтому тип возвращаемого значения указан явно:
     * без него вывод типов зацикливается на самой таблице.
     */
    hostOperatorId: idRef<'operator'>().references((): AnyPgColumn => operators.id, {
      // Оператора, на сети которого работают чужие абоненты, удалять нельзя:
      // MVNO без хозяина — запись, по которой не определить физическую сеть.
      onDelete: 'restrict',
    }),

    /**
     * Когда человек подтвердил запись ([ADR-0032](../../../docs/adr/0032-zagruzka-plana-numeracii.md),
     * [ADR-0035](../../../docs/adr/0035-operator-vladeet-svoey-setyu.md)).
     *
     * Пусто — запись завёл импорт плана нумерации, и человек её не смотрел.
     * **Вызовам это не мешает:** `is_mvno = false` — не утверждение, а отказ от него,
     * и маршрутизация при нём требует SIM ровно этого оператора. Отметка нужна, чтобы
     * видеть неразобранное, и обязательна лишь у оператора, назначаемого хозяином сети
     * чужих абонентов: вот это утверждение маршрутизацию расширяет.
     */
    verifiedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('operators_name_key').on(t.name),
    index('operators_inn_idx').on(t.inn),
    index('operators_mnc_idx').on(t.mnc),
    // Сеть хозяина осмысленна только у виртуального оператора, и наоборот:
    // MVNO без хозяина — запись, по которой нельзя определить физическую сеть.
    check(
      'operators_mvno_has_host',
      sql`(${t.isMvno} = false and ${t.hostOperatorId} is null) or (${t.isMvno} = true and ${t.hostOperatorId} is not null)`,
    ),
    // Оператор не может быть хозяином сети сам себе: такая запись зациклит разрешение.
    check(
      'operators_host_is_other',
      sql`${t.hostOperatorId} is null or ${t.hostOperatorId} <> ${t.id}`,
    ),
  ],
);

/**
 * Написания названия оператора во внешних источниках.
 *
 * Без этой таблицы сопоставить ответы невозможно: файл плана нумерации пишет
 * «ООО "Сбербанк-Телеком"», внешний сервис отвечает «Сбербанк-Телеком», а люди говорят
 * «СберМобайл». Сравнивать названия строками — значит заводить трёх операторов вместо
 * одного и терять определение на каждом.
 */
export const operatorAliases = pgTable(
  'operator_aliases',
  {
    id: primaryId<'operatorAlias'>(),
    operatorId: idRef<'operator'>()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    /**
     * Написание в приведённом виде: нижний регистр, без кавычек и организационной формы.
     * Приводит приложение, база следит, чтобы это не забыли.
     */
    alias: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('operator_aliases_alias_key').on(t.alias),
    index('operator_aliases_operator_idx').on(t.operatorId),
    check('operator_aliases_normalized', sql`${t.alias} = lower(${t.alias})`),
  ],
);

/**
 * Диапазоны плана нумерации из бесплатных источников.
 *
 * Отвечает на вопрос «кому диапазон выделен», а не «кто обслуживает номер».
 * Для перенесённого номера ответ неверен — поэтому разрешение из этой таблицы
 * не считается подтверждённым и вызов по нему не совершается.
 */
export const numberingPlanRanges = pgTable(
  'numbering_plan_ranges',
  {
    id: primaryId<'numberingPlanRange'>(),

    /** Три цифры после кода страны. Хранится отдельно — по нему сужается поиск. */
    defCode: text().notNull(),

    /**
     * Границы диапазона целым числом в том же виде, что и номер: `79130300000`.
     *
     * `bigint`, а не пара «код плюс смещение»: сравнение `start <= номер <= end`
     * должно быть одним условием по индексу, иначе поиск диапазона на каждый вызов
     * превращается в перебор.
     */
    rangeStart: bigint({ mode: 'bigint' }).notNull(),
    rangeEnd: bigint({ mode: 'bigint' }).notNull(),
    capacity: integer().notNull(),

    operatorId: idRef<'operator'>()
      .notNull()
      // Оператор с выделенным диапазоном не удаляется: иначе диапазон осиротеет,
      // и номера из него перестанут определяться вовсе.
      .references(() => operators.id, { onDelete: 'restrict' }),

    region: text(),
    source: text().$type<NumberingPlanSource>().notNull(),

    /** Когда загружен. Файлы обновляются ежедневно, и старые записи вытесняются новыми. */
    importedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('numbering_plan_ranges_source_check', oneOf(t.source, NUMBERING_PLAN_SOURCES)),
    check('numbering_plan_ranges_bounds', sql`${t.rangeStart} <= ${t.rangeEnd}`),
    check('numbering_plan_ranges_capacity', sql`${t.capacity} > 0`),
    // Один и тот же диапазон приходит из обоих источников — это не конфликт,
    // а два независимых свидетельства; различаются они полем `source`.
    uniqueIndex('numbering_plan_ranges_key').on(t.source, t.rangeStart, t.rangeEnd),
    // Основной запрос: найти диапазон, накрывающий номер.
    index('numbering_plan_ranges_lookup_idx').on(t.rangeStart, t.rangeEnd),
    index('numbering_plan_ranges_operator_idx').on(t.operatorId),
  ],
);

/**
 * Известный оператор конкретного номера — собственная база платформы.
 *
 * Наполняется ответами внешнего сервиса и переиспользуется: внешний источник нужен
 * не как источник истины в рантайме, а как способ наполнить эту таблицу. Через
 * несколько месяцев работы она покрывает рабочий набор номеров клиентов,
 * и обращения наружу становятся редкими.
 */
export const numberResolutions = pgTable(
  'number_resolutions',
  {
    id: primaryId<'numberResolution'>(),

    /** Номер в каноническом виде: одиннадцать цифр, начинается с семёрки. */
    msisdn: text().notNull(),

    operatorId: idRef<'operator'>()
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),

    /**
     * Прежний оператор, если номер переносился.
     *
     * Полезен как приоритет фонового обновления: номер, который уже переносили однажды,
     * с большей вероятностью перенесут снова.
     */
    previousOperatorId: idRef<'operator'>().references(() => operators.id, {
      onDelete: 'set null',
    }),

    region: text(),
    source: text().$type<ResolutionSource>().notNull(),

    resolvedAt: timestamptz().notNull(),

    /**
     * Срок годности записи (по умолчанию 30 дней, настраивается).
     *
     * Кэш «навсегда» неверен: абонент может перенести номер повторно, а ложная запись
     * здесь означает платный звонок вместо бесплатного. По истечении срока запись
     * не удаляется, а обновляется при следующем обращении к номеру: номера,
     * по которым не звонят, не обновляются никогда и не стоят ничего.
     */
    expiresAt: timestamptz().notNull(),

    /**
     * Отмена записи по обращению партнёра «вызов ушёл не в мою сеть».
     *
     * Действует немедленно, независимо от срока годности: партнёр видит счёт от своего
     * оператора и знает про ошибку раньше нас. Запись не удаляется — она нужна, чтобы
     * видеть, какие номера определялись неверно.
     */
    invalidatedAt: timestamptz(),

    /** Когда номером пользовались в последний раз и сколько всего. Приоритет обновления. */
    lastUsedAt: timestamptz(),
    useCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('number_resolutions_msisdn_key').on(t.msisdn),
    check('number_resolutions_source_check', oneOf(t.source, RESOLUTION_SOURCES)),
    check('number_resolutions_msisdn_format', sql`${t.msisdn} ~ '^7[0-9]{10}$'`),
    check('number_resolutions_ttl', sql`${t.expiresAt} > ${t.resolvedAt}`),
    // Прежний оператор — это другой оператор. Совпадение означает ошибку разбора ответа.
    check(
      'number_resolutions_previous_differs',
      sql`${t.previousOperatorId} is null or ${t.previousOperatorId} <> ${t.operatorId}`,
    ),
    // Фоновое обновление ходит по просроченным записям в порядке востребованности.
    index('number_resolutions_refresh_idx').on(t.expiresAt, t.lastUsedAt),
    index('number_resolutions_operator_idx').on(t.operatorId),
  ],
);

/**
 * Номера и диапазоны, звонить на которые запрещено
 * ([ADR-0024](../../../docs/adr/0024-chyornyy-spisok-nomerov.md)).
 *
 * Правило — это **префикс**; точный номер есть префикс длиной одиннадцать. Двух форм
 * записи нет: отдельная форма для точного номера означала бы две ветки проверки там,
 * где достаточно одной.
 *
 * Отбор устроен наоборот, чем кажется: не «найти правило, под которое подходит номер»,
 * а «взять все префиксы номера и поискать среди правил» — восемь значений в `IN`
 * по уникальному индексу вместо перебора таблицы с `like`.
 */
export const blockedNumbers = pgTable(
  'blocked_numbers',
  {
    id: primaryId<'blockedNumber'>(),

    /** Префикс в каноническом виде: от четырёх до одиннадцати цифр, начиная с семёрки. */
    prefix: text().notNull(),

    /**
     * Почему запрещено. Обязательно: чёрный список без причин через полгода
     * превращается в набор строк, которые никто не решается удалить.
     */
    note: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // Меньше четырёх цифр — это запрет всей страны (`7`) или всей мобильной связи (`79`).
    // Такую опечатку лучше не дать сделать: отказ в обслуживании из-за неё выглядит
    // для клиента точно так же, как авария платформы.
    check('blocked_numbers_prefix_format', sql`${t.prefix} ~ '^7[0-9]{3,10}$'`),
    check('blocked_numbers_note_not_empty', sql`length(btrim(${t.note})) > 0`),
    uniqueIndex('blocked_numbers_prefix_key').on(t.prefix),
  ],
);
