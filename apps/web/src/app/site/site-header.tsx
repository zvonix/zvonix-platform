'use client';

import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { NAV } from './nav';

/**
 * Шапка сайта. Ссылки — обычные `<a>`, а не клиентский переход: страницы сайта статичны, а переход
 * между ними полной загрузкой надёжнее, чем разбор состояния маршрутизатора за обратным прокси.
 */
export function SiteHeader({ cabinetUrl }: { cabinetUrl: string }) {
  const [open, setOpen] = useState(false);
  const login = cabinetUrl === '' ? '#' : `${cabinetUrl}/login`;

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
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                <a href={item.href} className="block rounded-md px-2 py-2.5 hover:bg-muted">
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
