/**
 * Сессия в браузере ([ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md)).
 *
 * Токен, доступный сценарию на странице, — это токен, который уносит первый же
 * скомпрометированный пакет во фронтенде. Поэтому браузеру он выдаётся cookie
 * с `HttpOnly`: сценарий делает запросы от лица жертвы, пока открыта вкладка,
 * но сам credential наружу не попадает.
 *
 * Готовой библиотеки здесь нет намеренно: разбирается один заголовок и собирается
 * одна cookie с фиксированным набором признаков. Зависимость ради тридцати строк
 * не заводится (правило 11 в CLAUDE.md), а признаки лучше держать на виду —
 * забытый `HttpOnly` не заметит ни один тест, кроме того, что смотрит именно сюда.
 */

import type { Config } from '../infra/tokens.js';

/** Имя защищённой cookie: браузер отдаёт её только с `Secure`, `Path=/` и без `Domain`. */
const SECURE_NAME = '__Host-zvonix_session';

/** Имя незащищённой: префикс `__Host-` без `Secure` браузер не примет. */
const PLAIN_NAME = 'zvonix_session';

/**
 * Заголовок, без которого изменяющий запрос по cookie не принимается.
 *
 * Значение не проверяется — важен сам факт. Чужая страница поставить произвольный
 * заголовок не может: запрос с ним требует предварительной проверки CORS, на которую
 * платформа не отвечает ничем.
 */
export const CSRF_HEADER = 'x-zvonix-web';

/** Методы, не меняющие состояние: им заголовок не нужен. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Ставится ли cookie с `Secure` — по адресу кабинета, на источнике которого она живёт.
 *
 * Своей переменной окружения для этого нет намеренно: адрес уже задан, и второй
 * источник того же факта рано или поздно разошёлся бы с первым (ADR-0037).
 * Принимается конфигурация, а не строка: `PUBLIC_BASE_URL` — адрес для узлов АТС,
 * на сервере площадки это `http://127.0.0.1:8000` и при кабинете на https
 * (ревизия ADR-0037), и выбирать между двумя адресами должна эта функция, а не вызов.
 */
export function secureCookies(config: Pick<Config, 'WEB_BASE_URL'>): boolean {
  return config.WEB_BASE_URL.startsWith('https://');
}

/**
 * Имя cookie для текущей настройки.
 *
 * Читается и ставится **только** оно. Принимать оба имени значило бы вернуть щель,
 * ради которой префикс `__Host-` и взят: в проде соседний поддомен поставил бы
 * `zvonix_session` на весь домен, и защитник принял бы её.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_NAME : PLAIN_NAME;
}

/**
 * Достаёт токен сессии из заголовка `Cookie`.
 *
 * Возвращает `undefined` на всём, что не подходит, включая пустое значение:
 * `zvonix_session=` — это не сессия, а мусор от неудачного снятия.
 */
export function readSessionCookie(header: string | undefined, secure: boolean): string | undefined {
  if (header === undefined) return undefined;
  const wanted = sessionCookieName(secure);

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== wanted) continue;

    // Значение — base64url, в котором процентного кодирования быть не может.
    // Раскодировать его всё же надо: браузер возвращает ровно то, что мы поставили,
    // а поставить могли и не мы.
    const raw = part.slice(separator + 1).trim();
    if (raw === '') return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Собирает `Set-Cookie` со сроком по сроку сессии.
 *
 * `Max-Age`, а не `Expires`: срок считается от получения, и разъехавшиеся часы
 * на машине посетителя не превращают действующую сессию в просроченную.
 */
export function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const seconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return attributes(`${sessionCookieName(secure)}=${encodeURIComponent(token)}`, secure, seconds);
}

/**
 * Собирает `Set-Cookie`, снимающий сессию.
 *
 * Признаки те же, что при выдаче: браузер сопоставляет cookie по имени, пути
 * и домену, и снятие с другим `Path` оставило бы прежнюю на месте.
 */
export function clearSessionCookie(secure: boolean): string {
  return attributes(`${sessionCookieName(secure)}=`, secure, 0);
}

function attributes(pair: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [pair, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${String(maxAgeSeconds)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
