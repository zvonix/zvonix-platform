'use client';

import { ChevronDown, Menu, PanelLeftClose, PanelLeftOpen, X, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

/**
 * Меню кабинета — по образцу ([DESIGN.md](../../../../docs/DESIGN.md), «Меню»).
 *
 * - На компьютере — колонка слева, сворачивается до значков (232 → 64 px) кнопкой
 *   в её верхней строке. Выбор запоминается в браузере: это удобство одного человека
 *   на одной машине, а не настройка, которую надо переносить.
 * - В свёрнутом виде название раздела всплывает своей подсказкой при наведении
 *   и при фокусе с клавиатуры: `title` появляется с задержкой и клавиатуре не виден.
 * - На телефоне колонки нет. У партнёра внизу четыре главные вкладки и «Ещё»,
 *   у остальных — кнопка меню в шапке. И то и другое открывает все разделы снизу.
 */

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Подпись нижней вкладки телефона, когда полная в неё не помещается. */
  readonly short?: string;
}

export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

const COLLAPSED_KEY = 'zvonix.nav.collapsed';

/**
 * Свёрнуто ли меню. Хранилище может быть недоступно (приватное окно) — тогда развёрнуто.
 *
 * Читается при первом рисовании, а не после него: меню рисуется, только когда сессия уже известна, то есть
 * не на сервере. Чтение «потом» давало мигание на каждом переходе — каждая страница строит меню заново, оно
 * на миг показывалось развёрнутым и тут же сворачивалось.
 */
function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const change = (next: boolean): void => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Не запомнится между заходами — меню всё равно свернётся сейчас.
    }
  };

  return [collapsed, change];
}

/** Раздел открыт: сам адрес или страница внутри него, например карточка `/partners/<id>`. */
export function isCurrent(pathname: string, href: string): boolean {
  const path = href.split('?')[0] ?? href;
  return pathname === path || pathname.startsWith(`${path}/`);
}

const CLOSED_GROUPS_KEY = 'zvonix.nav.closed';

/**
 * Какие группы меню свёрнуты. Как и свёрнутость колонки, это удобство одного человека на одной машине:
 * хранится в браузере, а при закрытом хранилище группы просто остаются развёрнутыми.
 */
function useClosedGroups(): [ReadonlySet<string>, (title: string, closed: boolean) => void] {
  // Из хранилища сразу, по той же причине, что и у `useCollapsed`: иначе при каждом переходе свёрнутая группа
  // на миг разворачивалась.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = window.localStorage.getItem(CLOSED_GROUPS_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed)
        ? new Set(parsed.filter((title): title is string => typeof title === 'string'))
        : new Set<string>();
    } catch {
      // Хранилище закрыто или в нём мусор — все группы развёрнуты.
      return new Set<string>();
    }
  });

  const change = (title: string, shut: boolean): void => {
    setClosed((previous) => {
      const next = new Set(previous);
      if (shut) next.add(title);
      else next.delete(title);
      try {
        window.localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // Не запомнится между заходами — группа всё равно свернётся сейчас.
      }
      return next;
    });
  };

  return [closed, change];
}

export function SideNav({ groups, footer }: { groups: readonly NavGroup[]; footer: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useCollapsed();
  const [closedGroups, setGroupClosed] = useClosedGroups();

  // Переход в раздел свёрнутой группы разворачивает её: человек должен видеть, где он.
  useEffect(() => {
    for (const group of groups) {
      if (group.items.some((item) => isCurrent(pathname, item.href))) {
        setGroupClosed(group.title, false);
      }
    }
    // Только смена адреса: иначе группа не сворачивалась бы вручную, пока открыта её страница.
  }, [pathname]);

  return (
    <nav
      aria-label="Разделы"
      // Свёрнутое не прокручивается: подсказка выходит за правый край колонки, а прокрутка
      // по одной оси обрезает и другую. Двенадцать значков в высоту экрана помещаются.
      // Ширина меняется плавно; у тех, кто просил меньше движения, — сразу.
      className={`sticky top-0 hidden h-dvh flex-col gap-2 bg-rail py-3 text-rail-ink transition-[width] duration-150 ease-out motion-reduce:transition-none md:flex print:hidden ${
        collapsed ? 'w-16 px-2' : 'w-[232px] overflow-y-auto px-2'
      }`}
    >
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-2'}`}>
        {!collapsed && (
          <span className="text-[15px] font-semibold tracking-tight text-white">Zvonix</span>
        )}
        <button
          type="button"
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
          aria-expanded={!collapsed}
          className={`flex size-8 items-center justify-center rounded-md text-rail-ink-dim transition-colors hover:bg-rail-active hover:text-white focus-visible:outline-2 focus-visible:outline-ring ${
            collapsed ? '' : 'ml-auto'
          }`}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} aria-hidden />
          ) : (
            <PanelLeftClose size={16} aria-hidden />
          )}
        </button>
      </div>

      {groups.map((group, index) => {
        // На узкой колонке значков группы не сворачиваются: там и так по одному значку на раздел.
        const open = collapsed || !closedGroups.has(group.title);
        const hasCurrent = group.items.some((item) => isCurrent(pathname, item.href));
        const listId = `nav-group-${String(index)}`;
        return (
          <div
            key={group.title}
            className={`flex flex-col gap-0.5 ${
              collapsed && index > 0 ? 'border-t border-rail-active pt-3' : ''
            }`}
          >
            {!collapsed && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => {
                  setGroupClosed(group.title, open);
                }}
                className="flex items-center gap-1 rounded-md px-2 pt-1.5 pb-1 text-left text-[10px] font-semibold tracking-widest text-rail-ink-dim uppercase transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronDown
                  size={11}
                  aria-hidden
                  className={`transition-transform duration-150 motion-reduce:transition-none ${
                    open ? '' : '-rotate-90'
                  }`}
                />
                {group.title}
                {!open && hasCurrent && (
                  <span
                    role="img"
                    aria-label="здесь открытый раздел"
                    className="ml-auto size-1.5 rounded-full bg-primary"
                  />
                )}
              </button>
            )}
            <div
              id={listId}
              // Свёрнутая группа не получает фокус с клавиатуры: `inert` убирает её из обхода.
              inert={!open}
              className={`grid transition-[grid-template-rows,visibility] duration-150 ease-out motion-reduce:transition-none ${
                open ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
              }`}
            >
              <div className={`flex flex-col gap-0.5 ${collapsed ? '' : 'overflow-hidden'}`}>
                {group.items.map((item) => {
                  const current = isCurrent(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      className={`group relative flex items-center gap-2 rounded-md py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                        collapsed ? 'justify-center px-0' : 'px-2'
                      } ${current ? 'bg-rail-active text-white' : 'hover:bg-rail-active hover:text-white'}`}
                    >
                      <item.Icon size={collapsed ? 17 : 14} strokeWidth={2} aria-hidden />
                      {collapsed ? (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute top-1/2 left-full z-40 ml-2 hidden -translate-y-1/2 rounded-md border border-border bg-card px-2 py-1 whitespace-nowrap text-card-foreground shadow-md group-hover:block group-focus-visible:block"
                        >
                          {item.label}
                        </span>
                      ) : (
                        item.label
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {!collapsed && (
        <div className="mt-auto px-2 pt-2 text-[11px] text-rail-ink-dim">{footer}</div>
      )}
    </nav>
  );
}

/** Все разделы снизу экрана — для телефона. */
function AllSections({
  groups,
  trigger,
  footer,
}: {
  groups: readonly NavGroup[];
  trigger: ReactNode;
  footer: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Переход по разделу закрывает лист: иначе он остался бы поверх новой страницы.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="sheet-overlay"
          className="fixed inset-0 z-50 bg-foreground/40"
        />
        <DialogPrimitive.Content
          data-slot="sheet-content"
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col gap-3 overflow-y-auto rounded-t-2xl border-t border-border bg-card px-4 pt-3 pb-6 text-card-foreground shadow-lg"
        >
          <div className="flex items-center">
            <DialogPrimitive.Title className="text-base font-semibold">
              Все разделы
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Переход в любой раздел кабинета
            </DialogPrimitive.Description>
            <DialogPrimitive.Close
              aria-label="Закрыть"
              className="ml-auto flex size-9 items-center justify-center rounded-md border border-border"
            >
              <X size={16} aria-hidden />
            </DialogPrimitive.Close>
          </div>
          {groups.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              <div className="pb-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                {group.title}
              </div>
              {group.items.map((item) => {
                const current = isCurrent(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-md px-2 ${
                      current ? 'bg-muted font-semibold' : 'hover:bg-muted'
                    }`}
                  >
                    <item.Icon size={17} strokeWidth={2} aria-hidden />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
          <div className="border-t border-border pt-3 text-xs text-muted-foreground">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Кнопка меню в шапке телефона — у сотрудников и клиента. */
export function MobileMenuButton({
  groups,
  footer,
}: {
  groups: readonly NavGroup[];
  footer: ReactNode;
}) {
  return (
    <AllSections
      groups={groups}
      footer={footer}
      trigger={
        <button
          type="button"
          aria-label="Все разделы"
          className="flex size-9 items-center justify-center rounded-md border border-border md:hidden"
        >
          <Menu size={18} aria-hidden />
        </button>
      }
    />
  );
}

/**
 * Нижние вкладки телефона — у партнёра: он работает с телефона в поле, и главные
 * разделы должны быть под пальцем, а не за кнопкой меню.
 */
export function MobileTabs({ groups, footer }: { groups: readonly NavGroup[]; footer: ReactNode }) {
  const pathname = usePathname();
  const main = groups.flatMap((group) => group.items).slice(0, 4);

  return (
    <nav
      aria-label="Главные разделы"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      {main.map((item) => {
        const current = isCurrent(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-center text-[11px] leading-tight ${
              current ? 'font-semibold text-primary' : 'text-muted-foreground'
            }`}
          >
            <item.Icon size={18} strokeWidth={2} aria-hidden />
            {item.short ?? item.label}
          </Link>
        );
      })}
      <AllSections
        groups={groups}
        footer={footer}
        trigger={
          <button
            type="button"
            className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
          >
            <Menu size={18} aria-hidden />
            Ещё
          </button>
        }
      />
    </nav>
  );
}
