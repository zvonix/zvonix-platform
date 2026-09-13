import { describe, expect, it } from 'vitest';
import {
  buildSessionCookie,
  clearSessionCookie,
  isSafeMethod,
  readSessionCookie,
  secureCookies,
  sessionCookieName,
} from './session-cookie.js';

describe('признак Secure', () => {
  it('следует за адресом платформы', () => {
    expect(secureCookies('https://cp.example.com')).toBe(true);
    expect(secureCookies('http://127.0.0.1:8000')).toBe(false);
  });
});

describe('имя cookie', () => {
  it('с Secure получает префикс __Host-', () => {
    expect(sessionCookieName(true)).toBe('__Host-zvonix_session');
  });

  it('без Secure остаётся без префикса: __Host- без Secure браузер не примет', () => {
    expect(sessionCookieName(false)).toBe('zvonix_session');
  });
});

describe('сборка cookie', () => {
  const token = 'aBc-123_xyz';

  it('несёт все признаки защиты', () => {
    const cookie = buildSessionCookie(token, new Date(Date.now() + 60_000), true);
    expect(cookie).toContain('__Host-zvonix_session=aBc-123_xyz');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('без Secure не ставит признак и не берёт префикс', () => {
    const cookie = buildSessionCookie(token, new Date(Date.now() + 60_000), false);
    expect(cookie).toContain('zvonix_session=');
    expect(cookie).not.toContain('__Host-');
    // Именно `Secure`, а не подстрока чужого слова: `SameSite` его не содержит,
    // но проверка должна остаться верной и если признаки поменяются местами.
    expect(cookie.split('; ')).not.toContain('Secure');
  });

  it('срок задаётся Max-Age, а не Expires: часы посетителя нам неизвестны', () => {
    const cookie = buildSessionCookie(token, new Date(Date.now() + 3_600_000), true);
    expect(cookie).not.toContain('Expires');
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(maxAge).toBeGreaterThan(3590);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  it('просроченный срок не даёт отрицательного Max-Age', () => {
    const cookie = buildSessionCookie(token, new Date(Date.now() - 1000), true);
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('снятие cookie', () => {
  it('повторяет признаки выдачи: иначе браузер снимет не ту', () => {
    const cleared = clearSessionCookie(true);
    expect(cleared).toContain('__Host-zvonix_session=;');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Secure');
  });
});

describe('чтение cookie', () => {
  it('находит своё значение среди чужих', () => {
    const header = 'theme=dark; __Host-zvonix_session=token-value; lang=ru';
    expect(readSessionCookie(header, true)).toBe('token-value');
  });

  it('терпит пробелы вокруг имени', () => {
    expect(readSessionCookie('a=1;   zvonix_session=v   ; b=2', false)).toBe('v');
  });

  it('читает только имя текущей настройки', () => {
    // Соседний поддомен может поставить `zvonix_session` на весь домен. В проде
    // защитник обязан её не заметить — ради этого и взят префикс __Host-.
    expect(readSessionCookie('zvonix_session=подделка', true)).toBeUndefined();
    expect(readSessionCookie('__Host-zvonix_session=v', false)).toBeUndefined();
  });

  it('не путает похожее имя', () => {
    expect(readSessionCookie('not_zvonix_session=v', false)).toBeUndefined();
    expect(readSessionCookie('zvonix_session_old=v', false)).toBeUndefined();
  });

  it('пустое значение сессией не считает', () => {
    expect(readSessionCookie('zvonix_session=', false)).toBeUndefined();
    expect(readSessionCookie('zvonix_session=   ', false)).toBeUndefined();
  });

  it('отсутствие заголовка и мусор в нём дают undefined', () => {
    expect(readSessionCookie(undefined, false)).toBeUndefined();
    expect(readSessionCookie('', false)).toBeUndefined();
    expect(readSessionCookie('просто строка без знака равенства', false)).toBeUndefined();
  });

  it('раскодирует значение и переживает негодное кодирование', () => {
    expect(readSessionCookie('zvonix_session=a%2Bb', false)).toBe('a+b');
    expect(readSessionCookie('zvonix_session=%E0%A4%A', false)).toBeUndefined();
  });

  it('собранное читается обратно', () => {
    const built = buildSessionCookie('tok+en/value=', new Date(Date.now() + 60_000), false);
    const pair = built.split('; ')[0] ?? '';
    expect(readSessionCookie(pair, false)).toBe('tok+en/value=');
  });
});

describe('безопасные методы', () => {
  it('не меняющие состояние заголовка не требуют', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(isSafeMethod('head')).toBe(true);
    expect(isSafeMethod('OPTIONS')).toBe(true);
  });

  it('остальные требуют', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});
