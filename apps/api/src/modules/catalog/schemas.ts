/**
 * Схемы входных данных справочника операторов и тарифов.
 */

import {
  COMMISSION_MAX_BASIS_POINTS,
  COMMISSION_PRODUCTS,
  Money,
  ROUNDING_MODES,
  TERMINATION_KINDS,
  type MoneyAmount,
} from '@zvonix/shared';
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

/**
 * Подтверждение записи, заведённой импортом плана нумерации
 * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
 *
 * Те же три поля, что и при заведении вручную: подтвердить запись, не назвав признак
 * MVNO и хозяина сети, невозможно — именно их файл и не сообщает.
 */
export const verifyOperatorSchema = z
  .object({
    isMvno: z.boolean(),
    hostOperatorId: z.uuid('должен быть идентификатором').nullish(),
    mnc: mnc.nullish().transform((value) => value ?? null),
  })
  .refine((value) => value.isMvno === (value.hostOperatorId != null), {
    message: 'Хозяин сети указывается ровно для виртуального оператора',
    path: ['hostOperatorId'],
  });

export const addAliasSchema = z.object({ alias: name });

/** Оператор номера, подтверждённый человеком (ADR-0053). */
export const confirmNumberOperatorSchema = z.object({
  operatorId: z.uuid('должен быть идентификатором'),
});

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;
export type VerifyOperatorInput = z.infer<typeof verifyOperatorSchema>;

/**
 * Сумма в основных единицах: `1.20`, `0.000001`. Число здесь недопустимо (ADR-0010).
 *
 * **Отрицательная отвергается на входе.** Дальше её всё равно не пропустят — расчёт
 * тарифа проверяет знак сам, а в базе стоит `CHECK`, — но отказ оттуда приходит без
 * имени поля: человек видит «отрицательная цена или плата за соединение» и гадает,
 * какое из двух полей он испортил. Проверка на входе называет поле, и это тем важнее,
 * что цену теперь вводит партнёр, а не только администратор
 * ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 *
 * У всех денежных величин тарифа, коридора и наценки ограничение одно и то же —
 * неотрицательность, — поэтому проверка стоит на общей величине, а не на каждом поле.
 */
const tariffAmount = z
  .string()
  .trim()
  .min(1, 'не может быть пустой')
  .transform((value, ctx): MoneyAmount => {
    try {
      const amount = Money.fromMajorUnits(value);
      if (Money.compare(amount, Money.ZERO) < 0) {
        ctx.addIssue({ code: 'custom', message: 'не может быть отрицательной' });
        return Money.ZERO;
      }
      return amount;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'не похоже на денежную сумму' });
      return Money.ZERO;
    }
  });

export const addPartnerRateSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),

  /**
   * Тариф, которому принадлежит цена (ADR-0056). Не назван — тариф партнёра
   * по умолчанию.
   */
  tariffId: z.uuid('должен быть идентификатором').optional(),

  /**
   * Оператор назначения. Из ответа резолвера, а не из префикса номера (ADR-0013).
   * `null` или отсутствие — **цена на все операторы** тарифа (ADR-0056).
   */
  operatorId: z.uuid('должен быть идентификатором').nullable().optional(),

  /**
   * Через что уходит вызов по этой цене (ADR-0040).
   *
   * Умолчание `sim` — не удобство, а совместимость: на момент появления поля другого
   * способа не существует, и обработчик без него продолжает работать как прежде.
   * Появится транк — цену ему назовут явно.
   */
  terminationKind: z.enum(TERMINATION_KINDS).default('sim'),

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

/**
 * Цена, которую партнёр назначает себе сам ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 *
 * Отличий от административной схемы ровно два, и оба существенные:
 *
 * **Партнёра нет** — он выводится из сессии, как и во всём контуре `/partner/*`.
 *
 * **Момента начала действия нет.** Коридор проверяется тем, что действовал на этот
 * момент, — значит, приняв его от партнёра, мы дали бы ему выбрать время, когда коридор
 * был шире, то есть обойти ограничение, ради которого он и заведён. Цена партнёра
 * начинает действовать сейчас.
 *
 * Способ терминации **обязателен**: умолчание `sim` в административной схеме —
 * совместимость со списками, заведёнными до появления транков, а партнёр называет
 * свою ёмкость с первого раза.
 */
export const partnerOwnRateSchema = addPartnerRateSchema
  .omit({ partnerId: true, effectiveFrom: true })
  .extend({ terminationKind: z.enum(TERMINATION_KINDS) });

/** Имя тарифа партнёра (ADR-0056): то, что партнёр выбирает у шлюза и SIM. */
const tariffName = z.string().trim().min(1, 'не может быть пустым').max(60, 'не длиннее 60 знаков');

export const createTariffSchema = z.object({ name: tariffName });

/**
 * Изменение тарифа: имя и (или) «сделать тарифом по умолчанию». Снять умолчание нельзя —
 * только назначить другой тариф: без тарифа по умолчанию SIM осталась бы без цен.
 */
export const updateTariffSchema = z
  .object({ name: tariffName.optional(), isDefault: z.literal(true).optional() })
  .refine((body) => body.name !== undefined || body.isDefault !== undefined, {
    message: 'нечего менять',
  });

/**
 * Коридор цены по направлению (ADR-0023).
 *
 * Границы — стоимость **эталонного вызова** длительностью 60 секунд по тарифу партнёра,
 * а не цена за минуту: коридор по одной цене за минуту обходится платой за соединение
 * или минимальной длительностью в десять минут. Для простого тарифа это одно и то же число.
 */
export const addPriceBandSchema = z
  .object({
    operatorId: z.uuid('должен быть идентификатором'),

    /** Регион назначения. Пусто — коридор на любой регион. */
    region: z.string().trim().min(2, 'слишком короткий').max(100, 'слишком длинный').optional(),

    minPrice: tariffAmount,
    maxPrice: tariffAmount,

    /** Момент начала действия. По умолчанию — сейчас. */
    effectiveFrom: z.iso.datetime({ error: 'должен быть датой в формате ISO' }).optional(),
  })
  .refine((value) => value.maxPrice >= value.minPrice, {
    // Такое же ограничение стоит в базе. Здесь — ради внятного сообщения: коридор
    // с верхней границей ниже нижней не запрещает цену, а делает невозможной любую.
    message: 'Верхняя граница коридора ниже нижней',
    path: ['maxPrice'],
  });

const commissionProductSchema = z.enum(COMMISSION_PRODUCTS, {
  error: 'должно быть «call» или «message»',
});

/** Что наценяет правило; не названо — вызовы (так было до сообщений, ADR-0073). */
export const commissionRulesQuerySchema = z.object({
  product: commissionProductSchema.default('call'),
});

export const addCommissionRuleSchema = z
  .object({
    /** Что наценяет правило: вызовы (по умолчанию) или сообщения MAX (ADR-0073). */
    product: commissionProductSchema.default('call'),
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
      .max(100_000, 'наценка выше 1000% — это опечатка в разрядах')
      .default(0),

    effectiveFrom: z.iso.datetime({ error: 'должен быть датой в формате ISO' }).optional(),
  })
  .refine((value) => value.percentBasisPoints <= COMMISSION_MAX_BASIS_POINTS[value.product], {
    // У вызовов предел 100 %, у сообщений 1000 %: выше — опечатка в разрядах.
    message: 'наценка выше допустимой — это опечатка в разрядах',
    path: ['percentBasisPoints'],
  });

export const priceCallSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),
  clientId: z.uuid('должен быть идентификатором'),
  operatorId: z.uuid('должен быть идентификатором'),
  region: z.string().trim().max(100, 'слишком длинный').optional(),

  /** Через что уходит вызов: у SIM и транка цены разные (ADR-0040). */
  terminationKind: z.enum(TERMINATION_KINDS).default('sim'),

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

/**
 * Правило чёрного списка (ADR-0024).
 *
 * Префикс принимается в том виде, в каком его пишет человек (`8-809`, `+7 809`):
 * приведение к каноническому виду — забота службы, а не вводящего. Границы длины
 * проверяются там же, потому что считаются они уже по приведённому виду.
 */
export const blockNumberSchema = z.object({
  prefix: z.string().trim().min(1, 'не может быть пустым').max(30, 'слишком длинный'),

  /** Почему запрещено. Обязательно: список без причин никто не решается чистить. */
  note: z.string().trim().min(3, 'слишком короткая причина').max(300, 'слишком длинная причина'),
});
