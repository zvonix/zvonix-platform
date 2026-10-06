'use client';

import { Bookmark, Columns3, Trash2 } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useUrlState } from '@/lib/url-state';

/**
 * Вид таблицы под человека: какие колонки показывать и какие наборы фильтров держать под рукой.
 *
 * Ни то ни другое не настройка площадки, а удобство одного человека на одной машине (как тема и плотность
 * строк): хранится в браузере, при закрытом хранилище просто не запоминается. Страницы подключают это одной
 * строкой в панели фильтров и одним `{...columns.tableProps}` на таблице — свои колонки и фильтры они не описывают.
 */

const triggerClass =
  'flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';

const panelClass =
  'z-50 flex max-h-[60dvh] w-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-card p-2 text-card-foreground shadow-lg';

function readList(key: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Хранилище закрыто — выбор действует до перезагрузки страницы.
  }
}

// --- Колонки -----------------------------------------------------------------------------------

export interface ColumnPicker {
  /** Распространяется на `<Table>`: ссылка для чтения заголовков и признак скрытых колонок. */
  readonly tableProps: { ref: Ref<HTMLTableElement>; 'data-hide'?: string };
  /** Кнопка «Колонки» с окошком выбора; кладётся в панель фильтров. */
  readonly picker: ReactNode;
}

/**
 * Выбор колонок таблицы. Названия берутся из самой шапки (`thead th`), поэтому описывать колонки второй раз
 * не нужно и разойтись с таблицей им нечем. Запоминаются **названия** скрытых колонок, а не номера: добавленная
 * колонка не сдвинет выбор. Колонка без названия (кнопки действий) не скрывается; последнюю видимую не скрыть.
 */
export function useColumnPicker(key: string): ColumnPicker {
  const storageKey = `zvonix.columns.${key}`;
  const tableRef = useRef<HTMLTableElement>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    setHidden(readList(storageKey).filter((item): item is string => typeof item === 'string'));
  }, [storageKey]);

  // После каждой отрисовки: шапка может смениться (страница с вкладками). Меняется состояние, только если
  // названия другие, — цикла нет.
  useEffect(() => {
    const heads = tableRef.current?.querySelectorAll('thead th');
    const next = heads === undefined ? [] : [...heads].map((th) => th.textContent.trim());
    setLabels((previous) =>
      previous.length === next.length && previous.every((label, index) => label === next[index])
        ? previous
        : next,
    );
  });

  const choose = (label: string, show: boolean): void => {
    const next = show ? hidden.filter((item) => item !== label) : [...hidden, label];
    setHidden(next);
    writeList(storageKey, next);
  };
  const reset = (): void => {
    setHidden([]);
    writeList(storageKey, []);
  };

  const named = labels.filter((label) => label !== '');
  const shown = named.filter((label) => !hidden.includes(label));
  const hideIndexes = labels
    .map((label, index) => (label !== '' && hidden.includes(label) ? index + 1 : 0))
    .filter((index) => index > 0);

  const picker =
    named.length < 2 ? null : (
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <button type="button" className={triggerClass}>
            <Columns3 size={14} strokeWidth={2} aria-hidden />
            Колонки
            {hidden.length > 0 && (
              <span className="num rounded-sm bg-muted px-1 text-xs text-foreground">
                {String(shown.length)}/{String(named.length)}
              </span>
            )}
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            data-slot="popover-content"
            align="end"
            sideOffset={6}
            aria-label="Какие колонки показывать"
            className={panelClass}
          >
            {named.map((label) => {
              const visible = !hidden.includes(label);
              return (
                <label
                  key={label}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={visible}
                    // Последняя видимая колонка остаётся: таблица без колонок — это пустой экран.
                    disabled={visible && shown.length === 1}
                    onChange={(event) => {
                      choose(label, event.target.checked);
                    }}
                  />
                  {label}
                </label>
              );
            })}
            {hidden.length > 0 && (
              <button
                type="button"
                onClick={reset}
                className="mt-1 min-h-8 rounded-md border border-border px-2 hover:bg-muted"
              >
                Показать все
              </button>
            )}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    );

  return {
    tableProps: {
      ref: tableRef,
      ...(hideIndexes.length === 0 ? {} : { 'data-hide': hideIndexes.join(' ') }),
    },
    picker,
  };
}

// --- Сохранённые фильтры -----------------------------------------------------------------------

interface Saved {
  readonly name: string;
  readonly query: string;
}

const SAVED_LIMIT = 10;

/** Запрос без номера страницы и в одном порядке параметров: два одинаковых фильтра не должны выглядеть разными. */
function normalized(query: string): string {
  const parameters = new URLSearchParams(query);
  parameters.delete('offset');
  parameters.sort();
  return parameters.toString();
}

/**
 * Сохранённые наборы фильтров страницы. Набор — это то, что сейчас в адресе (кроме номера страницы): «Звонки по
 * Москве за неделю», «Только отказы». Применение подставляет его в адрес, а адрес — единственное место, где
 * живут фильтры ([DESIGN.md](../../../../docs/DESIGN.md)), поэтому набор можно ещё и передать ссылкой.
 */
export function SavedFilters() {
  const url = useUrlState();
  const pathname = usePathname();
  const storageKey = `zvonix.filters.${pathname}`;
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSaved(
      readList(storageKey).filter(
        (item): item is Saved =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Saved).name === 'string' &&
          typeof (item as Saved).query === 'string',
      ),
    );
  }, [storageKey]);

  const current = normalized(url.query);
  const active = saved.find((item) => normalized(item.query) === current);

  const store = (next: Saved[]): void => {
    setSaved(next);
    writeList(storageKey, next);
  };

  const trimmed = name.trim();
  const canSave =
    current !== '' && active === undefined && trimmed !== '' && saved.length < SAVED_LIMIT;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={triggerClass}>
          <Bookmark size={14} strokeWidth={2} aria-hidden />
          Наборы
          {active !== undefined && (
            <span className="max-w-24 truncate rounded-sm bg-muted px-1 text-xs text-foreground">
              {active.name}
            </span>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="popover-content"
          align="end"
          sideOffset={6}
          aria-label="Сохранённые наборы фильтров"
          className={panelClass}
        >
          {saved.length === 0 && (
            <p className="px-2 py-1 text-muted-foreground">Сохранённых наборов нет.</p>
          )}
          {saved.map((item) => (
            <div key={item.name} className="flex items-center gap-1">
              <button
                type="button"
                aria-pressed={item === active}
                onClick={() => {
                  url.apply(item.query);
                  // Набор применён — окно сделало своё дело: закрывается, таблица перед глазами.
                  setOpen(false);
                }}
                className={`min-h-8 flex-1 truncate rounded-md px-2 text-left hover:bg-muted ${
                  item === active ? 'bg-muted font-semibold' : ''
                }`}
              >
                {item.name}
              </button>
              <button
                type="button"
                aria-label={`Удалить набор «${item.name}»`}
                onClick={() => {
                  store(saved.filter((other) => other !== item));
                }}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-crit"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          ))}

          <form
            className="mt-1 flex flex-col gap-1 border-t border-border pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              store([
                ...saved.filter((item) => item.name !== trimmed),
                { name: trimmed, query: url.query },
              ]);
              setName('');
            }}
          >
            {current === '' ? (
              <p className="text-muted-foreground">
                Задайте фильтры на странице — их можно будет сохранить.
              </p>
            ) : active !== undefined ? (
              <p className="text-muted-foreground">Эти фильтры уже сохранены.</p>
            ) : (
              <>
                <input
                  aria-label="Название набора"
                  autoComplete="off"
                  maxLength={40}
                  placeholder="Название набора"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  className="h-9 rounded-md border border-input bg-transparent px-2"
                />
                <button
                  type="submit"
                  disabled={!canSave}
                  className="min-h-8 rounded-md border border-border px-2 hover:bg-muted disabled:opacity-50"
                >
                  Сохранить текущие
                </button>
                {saved.length >= SAVED_LIMIT && (
                  <p className="text-warn">
                    Наборов не больше {String(SAVED_LIMIT)}: удалите лишний.
                  </p>
                )}
              </>
            )}
          </form>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
