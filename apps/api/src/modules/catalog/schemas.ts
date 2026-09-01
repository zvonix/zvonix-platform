/**
 * Схемы входных данных справочника операторов.
 */

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
