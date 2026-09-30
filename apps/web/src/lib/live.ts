'use client';

import { useSyncExternalStore } from 'react';

/**
 * Как часто страницы с вызовами и оборудованием перечитывают данные сами.
 *
 * Одна настройка на браузер, а не на страницу: человек, включивший обновление на «Вызовах»,
 * ждёт того же на «Оборудовании». Хранится в браузере — это удобство одного человека, а не
 * состояние площадки. По умолчанию выключено: опрос — лишняя нагрузка на API, и включает его
 * тот, кому он нужен.
 *
 * Пока вкладка скрыта, TanStack Query опрос не ведёт (`refetchIntervalInBackground` по
 * умолчанию выключен) — фоновая вкладка API не нагружает.
 */
export const LIVE_OPTIONS = [
  { seconds: 0, label: 'выкл' },
  { seconds: 5, label: 'каждые 5 с' },
  { seconds: 15, label: 'каждые 15 с' },
] as const;

const KEY = 'zvonix.live-seconds';
const listeners = new Set<() => void>();

function read(): number {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return LIVE_OPTIONS.some((option) => option.seconds === value) ? value : 0;
  } catch {
    // Хранилище недоступно (приватное окно) — обновление просто выключено.
    return 0;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function setLiveSeconds(seconds: number): void {
  try {
    window.localStorage.setItem(KEY, String(seconds));
  } catch {
    // Без хранилища выбор живёт до перезагрузки страницы: подписчиков всё равно оповещаем.
  }
  for (const listener of listeners) listener();
}

/** Выбранный период в секундах; 0 — выключено. */
export function useLiveSeconds(): number {
  return useSyncExternalStore(subscribe, read, () => 0);
}

/** Значение для `refetchInterval`: `false` — не опрашивать. */
export function useLiveInterval(): number | false {
  const seconds = useLiveSeconds();
  return seconds === 0 ? false : seconds * 1000;
}
