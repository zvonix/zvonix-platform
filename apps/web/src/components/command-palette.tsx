'use client';

import { Radio, Search, Wallet } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { isCurrent, type NavGroup } from '@/components/shell-nav';
import { request } from '@/lib/api';

/**
 * Поиск по разделам — Ctrl+K (⌘K).
 *
 * Меню растёт: десятки разделов в нескольких группах не найти глазами. Окно ищет по названию раздела и группы
 * (все слова запроса должны встретиться), ведёт стрелками и Enter, закрывается Escape. Без запроса показывает
 * недавно открытые разделы. Ничего не знает о ролях: ему отдают то меню, которое видит человек, поэтому чужой
 * раздел найти нельзя.
 */

const RECENT_KEY = 'zvonix.nav.recent';
const RECENT_LIMIT = 5;

interface Entry {
  readonly href: string;
  readonly label: string;
  readonly group: string;
  readonly Icon: NavGroup['items'][number]['Icon'];
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((href): href is string => typeof href === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeRecent(hrefs: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(hrefs.slice(0, RECENT_LIMIT)));
  } catch {
    // Хранилище закрыто — недавних просто не будет.
  }
}

/** Кнопка «Поиск» для шапки и само окно. Горячая клавиша живёт, пока кабинет открыт. */
export function CommandPalette({
  groups,
  objects = false,
}: {
  groups: readonly NavGroup[];
  /** Искать ещё и клиентов с партнёрами (только сотрудникам: чужие списки остальным не отдаются). */
  objects?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [found, setFound] = useState<Entry[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          href: item.href,
          label: item.label,
          group: group.title,
          Icon: item.Icon,
        })),
      ),
    [groups],
  );

  // Недавние: открытый сейчас раздел встаёт первым, остальные сдвигаются.
  useEffect(() => {
    const match = entries.find((entry) => isCurrent(pathname, entry.href));
    if (match === undefined) return;
    const next = [match.href, ...readRecent().filter((href) => href !== match.href)];
    writeRecent(next);
  }, [pathname, entries]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // По коду клавиши, а не по букве: на русской раскладке Ctrl+K тоже должен работать.
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setRecent(readRecent());
    }
  }, [open]);

  // Клиенты и партнёры по названию: запрос уходит, когда человек перестал печатать на четверть секунды.
  useEffect(() => {
    const text = query.trim();
    if (!objects || !open || text.length < 2) {
      setFound([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = `name=${encodeURIComponent(text)}&limit=5`;
      void Promise.allSettled([
        request<{ clients: { id: string; name: string }[] }>(`/clients?${search}`, {
          signal: controller.signal,
        }),
        request<{ partners: { id: string; name: string }[] }>(`/partners?${search}`, {
          signal: controller.signal,
        }),
      ]).then(([clients, partners]) => {
        if (controller.signal.aborted) return;
        setFound([
          ...(clients.status === 'fulfilled'
            ? clients.value.clients.map((row) => ({
                href: `/clients/${row.id}`,
                label: row.name,
                group: 'Клиент',
                Icon: Wallet,
              }))
            : []),
          ...(partners.status === 'fulfilled'
            ? partners.value.partners.map((row) => ({
                href: `/partners/${row.id}`,
                label: row.name,
                group: 'Партнёр',
                Icon: Radio,
              }))
            : []),
        ]);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, objects, open]);

  const results = useMemo<Entry[]>(() => {
    const words = query
      .toLowerCase()
      .split(/\s+/u)
      .filter((word) => word !== '');
    if (words.length === 0) {
      const byHref = new Map(entries.map((entry) => [entry.href, entry]));
      return recent
        .map((href) => byHref.get(href))
        .filter((entry): entry is Entry => entry !== undefined && !isCurrent(pathname, entry.href));
    }
    const sections = entries.filter((entry) => {
      const haystack = `${entry.label} ${entry.group}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return [...sections, ...found];
  }, [query, entries, recent, pathname, found]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  function go(entry: Entry | undefined): void {
    if (entry === undefined) return;
    setOpen(false);
    router.push(entry.href);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Поиск по разделам"
          className="flex min-h-8 min-w-8 items-center justify-center gap-2 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Search size={13} strokeWidth={2} aria-hidden />
          <span className="hidden sm:inline">Поиск</span>
          <kbd className="num hidden rounded border border-border px-1 text-[10px] sm:inline">
            Ctrl K
          </kbd>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="palette-overlay"
          className="fixed inset-0 z-50 bg-foreground/40"
        />
        <DialogPrimitive.Content
          data-slot="palette-content"
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[70dvh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg"
        >
          <DialogPrimitive.Title className="sr-only">Поиск по разделам</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search size={15} className="text-muted-foreground" aria-hidden />
            <input
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={
                results[active] === undefined ? undefined : `palette-${String(active)}`
              }
              aria-label={objects ? 'Раздел, клиент или партнёр' : 'Название раздела'}
              autoComplete="off"
              spellCheck={false}
              placeholder={objects ? 'Раздел, клиент или партнёр…' : 'Название раздела…'}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive((value) => Math.min(value + 1, Math.max(results.length - 1, 0)));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((value) => Math.max(value - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  go(results[active]);
                }
              }}
              className="h-11 w-full bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul id="palette-list" ref={listRef} role="listbox" className="overflow-y-auto p-1">
            {query === '' && results.length > 0 && (
              <li
                role="presentation"
                className="px-2 py-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase"
              >
                Недавние
              </li>
            )}
            {results.map((entry, index) => (
              <li
                key={entry.href}
                id={`palette-${String(index)}`}
                role="option"
                aria-selected={index === active}
                onMouseMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  go(entry);
                }}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 ${
                  index === active ? 'bg-muted' : ''
                }`}
              >
                <entry.Icon
                  size={15}
                  strokeWidth={2}
                  className="text-muted-foreground"
                  aria-hidden
                />
                <span>{entry.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{entry.group}</span>
              </li>
            ))}
            {results.length === 0 && (
              <li role="presentation" className="px-3 py-6 text-center text-muted-foreground">
                {query === ''
                  ? 'Начните вводить название.'
                  : objects
                    ? 'Ничего не найдено.'
                    : 'Такого раздела нет.'}
              </li>
            )}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
