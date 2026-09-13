/**
 * Настройки площадки ([ADR-0031](../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Здесь живёт **закрытый список** значений, которые владелец меняет без доступа к серверу:
 * почта и ключи капчи. Всё, без чего процесс не стартует — адреса базы и Redis, порт,
 * `SECRET_KEY`, — остаётся в окружении ([ADR-0002](../../../docs/adr/0002-konfiguraciya.md))
 * и сюда не переезжает: ключ, которым расшифрован пароль почты, не может лежать
 * зашифрованным в той же таблице.
 *
 * Состав ключей задан в коде (`apps/api/src/modules/settings/settings.ts`), а не
 * произвольным набором строк: настройка, о которой знает только база, не проверяется
 * ничем и живёт до первой опечатки.
 */

import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, idRef, primaryId, updatedAt } from '../columns.js';
import { users } from './users.js';

export const platformSettings = pgTable(
  'platform_settings',
  {
    id: primaryId<'platformSetting'>(),

    /** Имя настройки из закрытого списка: `mail.host`, `captcha.server_key`. */
    key: text().notNull(),

    /**
     * Значение строкой. Число и признак приводятся по описанию из кода.
     *
     * У секретных настроек здесь **шифротекст** (AES-256-GCM ключом, выведенным
     * из `SECRET_KEY` с собственным назначением): дамп базы не должен отдавать
     * пароль почты и серверный ключ капчи.
     */
    value: text().notNull(),

    /** Кто менял последним. Полная история изменений — в журнале действий. */
    updatedByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('platform_settings_key_key').on(t.key)],
);
