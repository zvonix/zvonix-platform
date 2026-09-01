/**
 * Телефонный номер абонента в каноническом виде.
 *
 * Ключ, по которому хранится и ищется оператор номера (ADR-0013). Один и тот же номер
 * приходит от клиента десятком записей — `+7 913 042-41-23`, `8 (913) 0424123`,
 * `9130424123`. Если не приводить их к одному виду, база разрешений наполнится
 * дубликатами, и вместо попадания в кэш каждый вариант пойдёт во внешний сервис заново.
 *
 * Канонический вид: одиннадцать цифр, начинается с `7`. Без плюса — плюс не несёт
 * информации, но ломает сравнение строк.
 */

import { validationFailed } from './errors.js';

declare const msisdnBrand: unique symbol;

/** Номер, прошедший приведение к каноническому виду. Произвольную строку присвоить нельзя. */
export type Msisdn = string & { readonly [msisdnBrand]: true };

const RUSSIAN_LENGTH = 11;
const NATIONAL_LENGTH = 10;

/**
 * Приводит номер к каноническому виду.
 *
 * Возвращает `undefined` вместо исключения: номера приходят пачками из выгрузок клиента,
 * и один негодный не должен обрывать обработку всей пачки.
 *
 * Что делается:
 *   — отбрасывается всё, кроме цифр (плюс, скобки, дефисы, пробелы);
 *   — ведущая `8` заменяется на `7`: это междугородный префикс, а не часть номера,
 *     причём `8800…` — тоже он, а не DEF-код, начинающийся с восьмёрки;
 *   — десятизначная запись дополняется семёркой.
 *
 * Состав DEF-кода намеренно не проверяется. План нумерации меняется, и отказ звонить
 * на валидный номер из-за устаревшей проверки хуже, чем обращение к резолверу,
 * который всё равно ответит «оператор не найден».
 */
export function normalizeMsisdn(value: string): Msisdn | undefined {
  const digits = value.replace(/\D/g, '');

  if (digits.length === NATIONAL_LENGTH) {
    return `7${digits}` as Msisdn;
  }
  if (digits.length === RUSSIAN_LENGTH && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `7${digits.slice(1)}` as Msisdn;
  }
  return undefined;
}

/** Разбор номера, пришедшего снаружи. Негодный — отказ валидации, а не исключение общего вида. */
export function parseMsisdn(value: unknown, field = 'msisdn'): Msisdn {
  if (typeof value !== 'string') {
    throw validationFailed('Номер должен быть строкой', { details: { field } });
  }
  const normalized = normalizeMsisdn(value);
  if (normalized === undefined) {
    // Сам номер в сообщение не попадает: он персональные данные, а текст ошибки
    // уходит наружу и оседает в чужих логах.
    throw validationFailed('Номер не похож на российский', { details: { field } });
  }
  return normalized;
}

export function isMsisdn(value: unknown): value is Msisdn {
  return typeof value === 'string' && /^7\d{10}$/.test(value);
}

/** DEF-код — три цифры после кода страны. По нему группируются диапазоны плана нумерации. */
export function defCode(msisdn: Msisdn): string {
  return msisdn.slice(1, 4);
}

/**
 * Номер как целое число — в этом виде хранятся границы диапазонов плана нумерации.
 *
 * `BigInt`, а не `number`: одиннадцать цифр укладываются в `Number.MAX_SAFE_INTEGER`,
 * но арифметика диапазонов на числах с плавающей точкой — ровно тот класс ошибок,
 * который в этом проекте запрещён везде.
 */
export function toNumeric(msisdn: Msisdn): bigint {
  return BigInt(msisdn);
}

/** Обратное преобразование: граница диапазона из базы в канонический номер. */
export function fromNumeric(value: bigint): Msisdn | undefined {
  const digits = value.toString();
  return digits.length === RUSSIAN_LENGTH && digits.startsWith('7')
    ? (digits as Msisdn)
    : undefined;
}
