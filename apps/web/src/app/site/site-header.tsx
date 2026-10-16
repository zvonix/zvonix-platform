'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { NAV } from './nav';

/**
 * Шапка сайта. Ссылки — обычные `<a>`, а не клиентский переход: страницы сайта статичны, а переход
 * между ними полной загрузкой надёжнее, чем разбор состояния маршрутизатора за обратным прокси.
 */
/**
 * Адрес текущей страницы относительно корня сайта. Берётся из адресной строки, а не из маршрутизатора: за обратным
 * прокси сайт открыт в корне домена, а кабинет отдаёт его под `/site` — маршрутизатор видит второй путь.
 */
function currentPath(): string {
  const path = window.location.pathname.replace(/^\/site(?=\/|$)/u, '').replace(/\/+$/u, '');
  return path === '' ? '/' : path;
}

export function SiteHeader({ cabinetUrl }: { cabinetUrl: string }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string | undefined>(undefined);
  useEffect(() => {
    setPath(currentPath());
  }, []);
  const isCurrent = (href: string): boolean => path !== undefined && path === href;
  const login = `${cabinetUrl}/login`;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <a href="/" className="text-lg font-semibold tracking-tight">
          Zvonix
        </a>

        <nav aria-label="Разделы сайта" className="ml-4 hidden items-center gap-1 lg:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={isCurrent(item.href) ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground ${
                isCurrent(item.href)
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeSwitch />
          <a
            href={login}
            className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Войти
          </a>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-md border border-border lg:hidden"
            aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
          </button>
        </div>
      </div>

      {open && (
        <nav
          id="site-menu"
          aria-label="Разделы сайта"
          className="border-t border-border bg-background lg:hidden"
        >
          <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  aria-current={isCurrent(item.href) ? 'page' : undefined}
                  className={`block rounded-md px-2 py-2.5 hover:bg-muted ${
                    isCurrent(item.href) ? 'bg-muted font-medium' : ''
                  }`}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
