import { NextResponse, type NextRequest } from 'next/server';

/**
 * Без cookie сессии — сразу на вход, ещё до страницы: иначе кабинет на мгновение рисовал пустую рамку раздела
 * («Обновления») и только потом, получив `401` от `/api/auth/me`, уходил на вход (владелец, 2026-10-23).
 *
 * Это **оптимистичная** проверка, не защита: смотрится лишь наличие cookie, а не её действительность — сессию проверяет API
 * ([ADR-0037](../../../docs/adr/0037-sessiya-v-brauzere.md)), и без неё он не отдаёт ни одного байта данных. Истёкшая cookie
 * проходит сюда, и тогда, как прежде, на вход уводит оболочка кабинета.
 */

/** Страницы без входа. Новая открытая страница вписывается сюда — иначе она будет просить вход, а не откроется всем. */
const PUBLIC_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/confirm-email',
  '/setup',
  '/site',
] as const;

/** Имя cookie ставит API: с `Secure` — с префиксом `__Host-` (`apps/api/src/http/session-cookie.ts`). */
const SESSION_COOKIES = ['__Host-zvonix_session', 'zvonix_session'] as const;

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const signedIn = SESSION_COOKIES.some((name) => (request.cookies.get(name)?.value ?? '') !== '');
  if (isPublic || signedIn) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // API, сборка Next и файлы с расширением (значок, картинки) — мимо: им cookie не нужна, а `/api` отвечает сам.
  matcher: ['/((?!api/|_next/|.*\\.[^/]+$).*)'],
};
