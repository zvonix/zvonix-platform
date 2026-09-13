/**
 * Схемы запросов к настройкам площадки (ADR-0031).
 */

import { z } from 'zod';

/**
 * Изменение настроек — частичный объект.
 *
 * Ключи и виды значений проверяет служба по закрытому списку: держать вторую копию
 * списка в схеме значит завести два описания одного, которые разъедутся.
 */
export const changeSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, {
    message: 'Нечего менять',
  }),
});

/** Адрес для пробного письма. Пусто — берётся из настройки `mail.test_recipient`. */
export const testLetterSchema = z.object({
  recipient: z.email('должен быть почтовым адресом').optional(),
});
