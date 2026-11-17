'use client';

import { ChevronDown, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { CONTACTS, linkHref, NAV, type SiteGroup, type SiteLink } from './nav';

/**
 * Шапка сайта. Ссылки — обычные `<a>`, а не клиентский переход: страницы сайта статичны, а переход
 * между ними полной загрузкой надёжнее, чем разбор состояния маршрутизатора за обратным прокси.
 *
 * На компьютере — три группы с подменю и «Контакты»; подменю открывается наведением и щелчком, закрывается
 * Esc, щелчком мимо и уходом фокуса. Это раскрывающийся список ссылок (кнопка с `aria-expanded`), а не `role="menu"`:
 * в навигации сайта стрелочная клавиатура меню только мешала бы обычному Tab.
 * На телефоне — кнопка меню и те же группы списком с подписями.
 */

/**
 * Адрес текущей страницы относительно корня сайта. Берётся из адресной строки, а не из маршрутизатора: за обратным
 * прокси сайт открыт в корне домена, а кабинет отдаёт его под `/site` — маршрутизатор видит второй путь.
 */
function currentPath(): string {
  const path = window.location.pathname.replace(/^\/site(?=\/|$)/u, '').replace(/\/+$/u, '');
  return path === '' ? '/' : path;
}

/** Сколько ждать, прежде чем закрыть подменю, когда мышь ушла: иначе оно гаснет на пути от кнопки к пункту. */
const HOVER_CLOSE_MS = 150;

function DesktopGroup({
  group,
  index,
  open,
  setOpen,
  isCurrent,
  cabinetUrl,
}: {
  group: SiteGroup;
  index: number;
  open: boolean;
  setOpen: (next: boolean) => void;
  isCurrent: (link: SiteLink) => boolean;
  cabinetUrl: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  // Открыто наведением: щелчок по кнопке тогда не закрывает подменю — иначе мышь, пришедшая щёлкнуть,
  // закрывала бы то, что только что открыла.
  const byHover = useRef(false);
  const hasCurrent = group.items.some(isCurrent);
  const listId = `site-group-${String(index)}`;

  const cancelClose = (): void => {
    window.clearTimeout(closeTimer.current);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  useEffect(() => cancelClose, []);

  return (
    <div
      ref={wrapper}
      className="relative"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelClose();
        if (!open) byHover.current = true;
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelClose();
        closeTimer.current = window.setTimeout(() => {
          byHover.current = false;
          setOpen(false);
        }, HOVER_CLOSE_MS);
      }}
      onBlur={(event) => {
        // Фокус ушёл за пределы группы (Tab дальше) — подменю закрывается, иначе оно висит над соседней группой.
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (byHover.current) {
            byHover.current = false;
            setOpen(true);
            return;
          }
          setOpen(!open);
        }}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground ${
          hasCurrent || open ? 'bg-muted text-foreground' : 'text-muted-foreground'
        } ${hasCurrent ? 'font-medium' : ''}`}
      >
        {group.title}
        <ChevronDown
          size={14}
          aria-hidden
          className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {/* Мостик без зазора между кнопкой и списком: мышь, идущая вниз, не покидает группу. */}
      <div id={listId} hidden={!open} className="absolute top-full left-0 z-50 min-w-56 pt-1.5">
        <ul className="flex flex-col rounded-lg border border-border bg-card p-1.5 shadow-lg">
          {group.items.map((item) => {
            const current = isCurrent(item);
            return (
              <li key={item.href}>
                <a
                  href={linkHref(item, cabinetUrl)}
                  aria-current={current ? 'page' : undefined}
                  className={`block rounded-md px-3 py-2 whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground ${
                    current ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function SiteHeader({ cabinetUrl }: { cabinetUrl: string }) {
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | undefined>(undefined);
  const [path, setPath] = useState<string | undefined>(undefined);
  useEffect(() => {
    setPath(currentPath());
  }, []);
  const isCurrent = (link: SiteLink): boolean =>
    link.cabinet !== true && path !== undefined && path === link.href;
  const login = `${cabinetUrl}/login`;
  const register = `${cabinetUrl}/register`;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <a href="/" className="text-lg font-semibold tracking-tight">
          Zvonix
        </a>

        <nav aria-label="Разделы сайта" className="ml-4 hidden items-center gap-1 lg:flex">
          {NAV.map((group, index) => (
            <DesktopGroup
              key={group.title}
              group={group}
              index={index}
              open={openGroup === group.title}
              setOpen={(next) => {
                setOpenGroup((previous) =>
                  next ? group.title : previous === group.title ? undefined : previous,
                );
              }}
              isCurrent={isCurrent}
              cabinetUrl={cabinetUrl}
            />
          ))}
          <a
            href={CONTACTS.href}
            aria-current={isCurrent(CONTACTS) ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground ${
              isCurrent(CONTACTS) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
            }`}
          >
            {CONTACTS.label}
          </a>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeSwitch />
          <a
            href={login}
            className="rounded-md border border-border px-3 py-1.5 font-medium transition-colors hover:bg-muted"
          >
            Войти
          </a>
          <a
            href={register}
            className="hidden rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:inline-block"
          >
            Зарегистрироваться
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
          className="max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-t border-border bg-background lg:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3">
            {NAV.map((group) => (
              <div key={group.title} className="flex flex-col">
                <span className="px-2 pb-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                  {group.title}
                </span>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <a
                        href={linkHref(item, cabinetUrl)}
                        aria-current={isCurrent(item) ? 'page' : undefined}
                        className={`block rounded-md px-2 py-2 hover:bg-muted ${
                          isCurrent(item) ? 'bg-muted font-medium' : ''
                        }`}
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <a
              href={CONTACTS.href}
              aria-current={isCurrent(CONTACTS) ? 'page' : undefined}
              className={`block rounded-md border-t border-border px-2 pt-3 pb-2 hover:bg-muted ${
                isCurrent(CONTACTS) ? 'bg-muted font-medium' : ''
              }`}
            >
              {CONTACTS.label}
            </a>
            <a
              href={register}
              className="rounded-md bg-primary px-3 py-2.5 text-center font-medium text-primary-foreground sm:hidden"
            >
              Зарегистрироваться
            </a>
          </div>
        </nav>
      )}
    </header>
  );
}
