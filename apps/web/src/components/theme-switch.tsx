'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyTheme, isTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Светлая тема', Icon: Sun },
  { value: 'dark', label: 'Тёмная тема', Icon: Moon },
  { value: 'system', label: 'Тема как в системе', Icon: Monitor },
];

/**
 * Переключатель темы: светлая, тёмная, как в системе.
 *
 * Три положения, а не два. «Как в системе» — не то же самое, что светлая:
 * оно продолжает следовать за системой, когда та переключается по расписанию.
 *
 * До монтирования рисуется разметка без выделенного положения: сервер не знает,
 * что лежит в хранилище браузера, и выделенная не та кнопка была бы хуже,
 * чем не выделенная ни одна.
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme | undefined>(undefined);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Приватное окно или запрет данных сайта: тема просто не запоминается.
    }
    setTheme(isTheme(stored) ? stored : 'system');
  }, []);

  function choose(next: Theme): void {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // См. выше: выбор действует до перезагрузки страницы.
    }
  }

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
      role="group"
      aria-label="Тема оформления"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => {
            choose(value);
          }}
          className={
            theme === value
              ? 'rounded-sm bg-accent p-1 text-accent-foreground'
              : 'rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground'
          }
        >
          <Icon size={14} strokeWidth={2} aria-hidden />
        </button>
      ))}
    </div>
  );
}
