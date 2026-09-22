/**
 * Хеширование паролей.
 *
 * Argon2id — выбор по рекомендации OWASP: устойчив и к перебору на видеокартах
 * (за счёт требований к памяти), и к атакам по побочным каналам. Параметры заданы явно,
 * а не оставлены умолчаниями библиотеки: умолчания меняются между версиями,
 * а стойкость уже выданных хешей от этого зависеть не должна.
 *
 * Используется `@node-rs/argon2` — готовые бинарники для Linux и Windows,
 * без компиляции при установке.
 */

import { hash, verify } from '@node-rs/argon2';

/**
 * Рекомендация OWASP для Argon2id: 19 МиБ памяти, две итерации, один поток.
 * Изменение любого из чисел не ломает старые хеши — параметры записаны внутри самого хеша.
 *
 * Алгоритм и версия не указаны намеренно: библиотека объявляет их как `const enum`,
 * а он недоступен при `verbatimModuleSyntax`. Её умолчания — как раз Argon2id и v19,
 * и это не предположение: `password.test.ts` проверяет префикс полученного хеша.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Начало хеша, которое обязан давать выбранный алгоритм. Проверяется тестом. */
export const EXPECTED_HASH_PREFIX = '$argon2id$v=19$';

/**
 * Хеш пароля, с которым сравнивают, когда учётной записи не существует.
 *
 * Без него ответ на неизвестный адрес приходит заметно быстрее, чем на известный
 * с неверным паролем, и по времени ответа можно собрать список зарегистрированных
 * адресов, не зная ни одного пароля.
 */
let dummyHash: string | undefined;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/** Проверка пароля. Ошибку разбора хеша считаем несовпадением, а не сбоем. */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Сжигает столько же времени, сколько заняла бы проверка настоящего пароля.
 * Вызывается, когда учётная запись не найдена.
 */
export async function burnVerificationTime(plain: string): Promise<void> {
  dummyHash ??= await hashPassword('пароль, которого не существует');
  await verifyPassword(plain, dummyHash);
}
