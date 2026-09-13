'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Состояние вида живёт в адресе страницы.
 *
 * Требование [DESIGN.md](../../../../docs/DESIGN.md): фильтры, сортировка и диапазон
 * переживают перезагрузку и передаются ссылкой. «Посмотри вот на это» — обычный способ
 * позвать коллегу разобраться, и он не должен звучать как «открой аудит, выбери период,
 * потом действие».
 *
 * `replace`, а не `push`: смена фильтра — не переход. Иначе кнопка «назад» отматывает
 * по одному нажатию клавиши в поле поиска.
 */
export interface UrlState {
  /** Значение параметра. Отсутствующий и пустой параметр — одно и то же. */
  get: (key: string) => string;
  /** Задаёт значения; пустая строка убирает параметр из адреса. */
  set: (values: Record<string, string>) => void;
  /** Всё, что задано, — готовой строкой запроса для API. */
  query: string;
}

export function useUrlState(): UrlState {
  const router = useRouter();
  const pathname = usePathname();
  const parameters = useSearchParams();

  const get = useCallback((key: string) => parameters.get(key) ?? '', [parameters]);

  const set = useCallback(
    (values: Record<string, string>) => {
      const next = new URLSearchParams(parameters.toString());
      for (const [key, value] of Object.entries(values)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      const search = next.toString();
      router.replace(search === '' ? pathname : `${pathname}?${search}`, { scroll: false });
    },
    [parameters, pathname, router],
  );

  const query = useMemo(() => parameters.toString(), [parameters]);

  return { get, set, query };
}
