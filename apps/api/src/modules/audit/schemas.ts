/**
 * Схемы отбора для журнала действий.
 */

import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

/**
 * Потолок страницы журнала.
 *
 * Строка журнала несёт состояние до и после целиком, и это может быть килобайты.
 * Двести таких — уже мегабайты в одном ответе; для выгрузки понадобится свой путь,
 * а не увеличенный предел на этом.
 */
const AUDIT_PAGE_MAX = 200;

/**
 * Пустое значение параметра — это «любое», а не «пустое».
 *
 * Форма отбора шлёт все свои поля, и `?action=` означает «любое действие».
 * Без этого сброс фильтра в интерфейсе давал бы отказ вместо полного списка.
 */
const optionalParameter = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

/** Момент времени в виде ISO. Негодная строка — отказ: молча показать не тот период хуже. */
const moment = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.iso.datetime({ offset: true, message: 'должен быть моментом времени в виде ISO' }).optional(),
);

export const auditQuerySchema = z.object({
  action: optionalParameter,
  entityType: optionalParameter,
  entityId: optionalParameter,
  actorUserId: optionalParameter,
  correlationId: optionalParameter,
  from: moment,
  to: moment,
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, AUDIT_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});
