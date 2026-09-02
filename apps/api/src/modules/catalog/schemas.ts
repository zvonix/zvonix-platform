/**
 * Схемы входных данных справочника операторов и тарифов.
 */

import { Money, ROUNDING_MODES, type MoneyAmount } from '@zvonix/shared';
import { z } from 'zod';

const name = z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное');

/**
 * ИНН российского юридического лица — десять цифр, индивидуального предпринимателя —
 * двенадцать. По нему сливаются записи двух источников плана нумерации, поэтому
 * формат проверяется: ИНН с опечаткой не свяжет записи, а разведёт их.
 */
const inn = z
  .string()
  .trim()
  .regex(/^(\d{10}|\d{12})$/, 'должен состоять из 10 или 12 цифр');

/**
 * MNC — код сети внутри страны. В России это две или три цифры (МТС `01`, t2 `20`).
 * Хранится строкой: ведущий ноль значим, а число его теряет.
 */
const mnc = z
  .string()
  .trim()
  .regex(/^\d{2,3}$/, 'должен состоять из 2 или 3 цифр');

export const createOperatorSchema = z
  .object({
    name,
    inn: inn.nullish().transform((value) => value ?? null),
    mnc: mnc.nullish().transform((value) => value ?? null),
    isMvno: z.boolean().default(false),
    /** Чья сеть обслуживает виртуального оператора. Обязателен ровно для MVNO. */
    hostOperatorId: z.uuid('должен быть идентификатором').nullish(),
    /** Написания названия во внешних источниках. Каноническое добавляется само. */
    aliases: z.array(name).max(20, 'слишком много написаний').default([]),
  })
  .refine((value) => value.isMvno === (value.hostOperatorId != null), {
    // То же ограничение стоит в базе. Здесь оно ради понятного сообщения:
    // MVNO без хозяина — запись, по которой нельзя определить физическую сеть.
    message: 'Хозяин сети указывается ровно для виртуального оператора',
    path: ['hostOperatorId'],
  });

export const addAliasSchema = z.object({ alias: name });

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;

/** Сумма в основных единицах: `1.20`, `0.000001`. Число здесь недопустимо (ADR-0010). */
const tariffAmount = z
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

export const addPartnerRateSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),

  /** Оператор назначения. Из ответа резолвера, а не из префикса номера (ADR-0013). */
  operatorId: z.uuid('должен быть идентификатором'),

  /** Регион назначения. Пусто — тариф на любой регион. */
  region: z.string().trim().min(2, 'слишком короткий').max(100, 'слишком длинный').optional(),

  pricePerMinute: tariffAmount,

  /** Шаг тарификации в секундах. Посекундная тарификация — это единица. */
  billingIncrementSeconds: z.coerce
    .number()
    .int('должен быть целым числом')
    .min(1, 'не может быть меньше секунды')
    .max(3600, 'шаг длиннее часа лишён смысла')
    .default(1),

  /**
   * Минимальная оплачиваемая длительность — первый оплачиваемый период целиком,
   * а не нижняя граница округления.
   */
  minimumDurationSeconds: z.coerce
    .number()
    .int('должна быть целым числом')
    .min(0, 'не может быть отрицательной')
    .max(3600, 'минимум длиннее часа лишён смысла')
    .default(0),

  connectionFee: tariffAmount.optional(),

  rounding: z.enum(ROUNDING_MODES).default('half_away_from_zero'),

  /** Момент начала действия. По умолчанию — сейчас. Прошлое не переоценивается. */
  effectiveFrom: z.iso.datetime({ error: 'должен быть датой в формате ISO' }).optional(),
});

export const addCommissionRuleSchema = z.object({
  /** Клиент, к которому относится правило. Пусто — правило платформы по умолчанию. */
  clientId: z.uuid('должен быть идентификатором').optional(),
  fixedFee: tariffAmount.optional(),

  /**
   * Доля от стоимости партнёра в десятитысячных: 15% = 1500. Выше 100% — опечатка
   * в разрядах, а не коммерческое решение, поэтому отвергается.
   */
  percentBasisPoints: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(0, 'не может быть отрицательной')
    .max(10_000, 'наценка выше 100% — это опечатка в разрядах')
    .default(0),

  effectiveFrom: z.iso.datetime({ error: 'должен быть датой в формате ISO' }).optional(),
});

export const priceCallSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),
  clientId: z.uuid('должен быть идентификатором'),
  operatorId: z.uuid('должен быть идентификатором'),
  region: z.string().trim().max(100, 'слишком длинный').optional(),

  durationSeconds: z.coerce
    .number()
    .int('должна быть целым числом секунд')
    .min(0, 'не может быть отрицательной')
    .max(86_400, 'сутки разговора — это ошибка, а не вызов'),

  /**
   * Момент, на который берутся правила. По умолчанию — сейчас.
   *
   * Задаётся явно, потому что тарификация CDR выполняется позже звонка, иногда сильно
   * позже: узел мог держать CDR на диске, пока control plane был недоступен.
   */
  at: z.iso.datetime({ error: 'должен быть датой в формате ISO' }).optional(),
});
