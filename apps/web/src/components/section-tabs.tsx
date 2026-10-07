'use client';

import type { ReactNode } from 'react';
import { useUrlState } from '@/lib/url-state';

export interface SectionTab {
  /** Значение в адресе: `?tab=<id>`. Первая вкладка — без параметра. */
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

/**
 * Вкладки одного раздела — «Звонки» и «Сообщения MAX» на страницах тарифов и лимитов.
 *
 * Выбранная вкладка живёт в адресе ([DESIGN.md](../../../../docs/DESIGN.md), «состояние вида в адресе»):
 * ссылкой можно позвать коллегу сразу на нужную. Рисуется одна вкладка — полоски нет совсем: вкладка
 * без соседа ничего не выбирает. Неизвестное значение в адресе открывает первую.
 */
export function SectionTabs({
  tabs,
  param = 'tab',
}: {
  tabs: readonly SectionTab[];
  param?: string;
}) {
  const url = useUrlState();
  const first = tabs[0];
  if (first === undefined) return null;
  if (tabs.length === 1) return <>{first.content}</>;

  const active = tabs.find((tab) => tab.id === url.get(param)) ?? first;

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Раздел" className="flex gap-1 border-b border-border">
        {tabs.map((tab) => {
          const selected = tab === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              onClick={() => {
                url.set({ [param]: tab === first ? '' : tab.id });
              }}
              className={`-mb-px min-h-9 border-b-2 px-3 transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                selected
                  ? 'border-primary font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`panel-${active.id}`} aria-labelledby={`tab-${active.id}`}>
        {active.content}
      </div>
    </div>
  );
}
