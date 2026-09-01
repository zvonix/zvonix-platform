/**
 * Журнал действий.
 *
 * Заводится вместе с первыми таблицами, а не «когда понадобится»: модуль, написанный
 * без журнала, потом не дописывают — его переписывают. В домене есть места, где журнал
 * обязателен по существу, а не для удобства: обращение к записи разговора
 * (персональные данные), ручное пополнение баланса, изменение коридора цен.
 */

import { index, inet, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, idRef, primaryId, timestamptz } from '../columns.js';
import { users } from './users.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId<'audit'>(),

    /**
     * Кто. Пусто у действий системы: истечение резерва, автоотключение SIM по порогу
     * неудач, фоновая сверка — у них нет инициатора-человека, и запись об этом
     * так же важна, как запись о действии администратора.
     */
    actorUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    /**
     * Роль на момент действия — копией, а не через связь. Роль учётной записи меняется,
     * и через год «кто это сделал» должно отвечать тем, кем человек был тогда.
     */
    actorRole: text(),

    /** Что сделано: `user.created`, `recording.downloaded`, `client.balance.credited`. */
    action: text().notNull(),

    /** Над чем: имя сущности и её идентификатор. */
    entityType: text().notNull(),
    entityId: text(),

    /**
     * Состояние до и после. Изменение хранится целиком, а не описанием: разбирать спор
     * по формулировке вроде «изменена цена» невозможно.
     *
     * Кладёт сюда данные вызывающий код, и он же отвечает за то, чтобы не попали пароли,
     * секреты и номера абонентов в открытом виде.
     */
    before: jsonb(),
    after: jsonb(),

    ip: inet(),
    userAgent: text(),

    /**
     * Тот же идентификатор, что и в логах (ADR-0004). Связывает строку журнала
     * со всеми записями лога того же запроса — иначе аудит и логи приходится
     * сопоставлять по времени, а это не работает под нагрузкой.
     */
    correlationId: text(),

    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorUserId),
    index('audit_log_occurred_at_idx').on(t.occurredAt),
    index('audit_log_correlation_idx').on(t.correlationId),
  ],
);
