/**
 * Схемы входных данных биллинга.
 *
 * Суммы принимаются **строкой** и разбираются в микроединицы. Число здесь недопустимо:
 * `0.1 + 0.2` в двоичной плавающей точке не равно `0.3`, и копейки теряются молча —
 * обнаруживается это на сверке через месяц, когда уже непонятно, где именно.
 */

import { CLIENT_STATUSES, Money, PARTNER_STATUSES, type MoneyAmount } from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

const name = z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное');

/**
 * Денежная сумма в основных единицах: `1500`, `1500.50`, `0.000001`.
 *
 * Разбор выполняет `Money.fromMajorUnits`, который отвергает больше шести знаков
 * после точки — за пределом микроединицы значение пришлось бы округлять, а округление
 * в этом проекте выполняется ровно один раз, при фиксации CDR.
 */
export const amount = z
  .string()
  .trim()
  .min(1, 'не может быть пустой')
  .transform((value, ctx): MoneyAmount => {
    try {
      return Money.fromMajorUnits(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'не похоже на денежную сумму' });
      return Money.ZERO;
    }
  });

/** Выплата нескольким партнёрам сразу: один ключ партии, у каждой строки свой партнёр и сумма. */
export const payoutBatchSchema = z.object({
  /** Ключ идемпотентности партии: повтор того же запроса выплат не удваивает. */
  batchKey: z.string().trim().min(8, 'слишком короткий').max(120, 'слишком длинный'),
  description: z.string().trim().min(2, 'слишком короткое').max(500, 'слишком длинное'),
  items: z
    .array(z.object({ partnerId: z.uuid('должен быть идентификатором'), amount }))
    .min(1, 'нужна хотя бы одна выплата')
    .max(100, 'не больше ста выплат за раз')
    .refine((items) => new Set(items.map((item) => item.partnerId)).size === items.length, {
      message: 'один партнёр дважды в партии',
    }),
});

export const createClientSchema = z.object({
  /** Учётная запись владельца. Она уже должна существовать и иметь роль `client`. */
  ownerUserId: z.uuid('должен быть идентификатором'),
  name,
  /** Насколько глубоко разрешено уходить в минус. По умолчанию — нисколько. */
  overdraftLimit: amount.optional(),
});

export const createPartnerSchema = z.object({
  ownerUserId: z.uuid('должен быть идентификатором'),
  name,
  /**
   * Псевдоним, под которым партнёра видит клиент (ADR-0014). Не должен намекать
   * на личность: настоящее имя в клиентский контур не попадает ни в каком виде.
   */
  displayName: name,
});

export const depositSchema = z.object({
  amount,
  /**
   * Ключ идемпотентности задаёт вызывающая сторона: повторная отправка формы
   * или повтор запроса не должны начислять деньги дважды.
   */
  idempotencyKey: z.string().trim().min(4, 'слишком короткий').max(200, 'слишком длинный'),
  description: z.string().trim().min(2, 'слишком короткое').max(500, 'слишком длинное'),
});

/**
 * Объявление партнёра о том, слушает ли он записи своих вызовов
 * ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
 */
export const recordingsAccessSchema = z.object({ listens: z.boolean() });

/**
 * Отбор клиентов.
 *
 * Пустое значение параметра — «любое», а не «пустое»: форма отбора шлёт все свои поля,
 * и сброс фильтра не должен давать отказ. Границы страницы разбираются общими
 * правилами ([pagination.ts](../../http/pagination.ts)).
 */
const optionalParameter = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

const CLIENT_PAGE_MAX = 200;

export const clientListQuerySchema = z.object({
  status: optionalParameter.pipe(z.enum(CLIENT_STATUSES).optional()),
  name: optionalParameter.pipe(z.string().trim().max(200, 'слишком длинное').optional()),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, CLIENT_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

const PARTNER_PAGE_MAX = 200;

/**
 * Отбор партнёров. Правила те же, что и у клиентов: пустое поле — «любое».
 */
export const partnerListQuerySchema = z.object({
  status: optionalParameter.pipe(z.enum(PARTNER_STATUSES).optional()),
  /** Ищет и по настоящему имени, и по псевдониму: администратор помнит одно из двух. */
  name: optionalParameter.pipe(z.string().trim().max(200, 'слишком длинное').optional()),
  /** `true` — только те, кому площадка должна: список к выплате. */
  owed: optionalParameter.pipe(z.enum(['true']).optional()),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, PARTNER_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

/**
 * Смена состояния партнёра.
 *
 * `closed` в списке есть: закрыть партнёра — законное действие администратора.
 * Необратимость этого перехода стережёт служба, а не схема, — здесь она выразилась бы
 * только запретом самого значения, и закрыть партнёра стало бы нечем.
 */
export const partnerStatusSchema = z.object({ status: z.enum(PARTNER_STATUSES) });

/**
 * Смена состояния клиента. Правила те же, что и у партнёра: `closed` в списке есть,
 * а необратимость этого перехода стережёт служба.
 */
export const clientStatusSchema = z.object({ status: z.enum(CLIENT_STATUSES) });

/**
 * Смена разрешённого минуса.
 *
 * Величина положительная: хранить предел со знаком минус — верный способ однажды
 * перепутать направление и раздать бесконечный кредит.
 */
export const overdraftSchema = z.object({ overdraftLimit: amount });

/**
 * Переименование псевдонима партнёра (ADR-0014).
 *
 * Не должен намекать на личность: это единственное, что клиент о партнёре знает,
 * и настоящее имя в клиентский контур не попадает ни в каком виде.
 */
export const partnerAliasSchema = z.object({ displayName: name });
