'use client';

import { useSyncExternalStore } from 'react';

/**
 * Как часто страницы с вызовами и оборудованием перечитывают данные сами.
 *
 * Одна настройка на браузер, а не на страницу: человек, включивший обновление на «Вызовах»,
 * ждёт того же на «Оборудовании». Хранится в браузере — это удобство одного человека, а не
 * состояние площадки.
 *
 * Пока человек ничего не выбрал, у каждой страницы своё значение по умолчанию: «Вызовы» и
 * «Оборудование» партнёра обновляются раз в `LIVE_BY_DEFAULT` секунд — на них смотрят, пока
 * идут вызовы (владелец, 2026-11-19), остальные страницы — выключены, опрос там лишняя нагрузка
 * на API. Сделанный выбор, и «выкл» тоже, сохраняется и дальше действует на всех страницах:
 * выключивший обновление на «Вызовах» не должен получить его снова на «Оборудовании».
 *
 * Пока вкладка скрыта, TanStack Query опрос не ведёт (`refetchIntervalInBackground` по
 * умолчанию выключен) — фоновая вкладка API не нагружает, а вернувшись, человек сразу видит
 * свежее (`refetchOnWindowFocus`). Перечитывается тот же запрос с тем же ключом: страница,
 * фильтры и период — в адресе, опрос их не трогает.
 */
export const LIVE_OPTIONS = [
  { seconds: 0, label: 'выкл' },
  { seconds: 5, label: 'каждые 5 с' },
  { seconds: 10, label: 'каждые 10 с' },
  { seconds: 15, label: 'каждые 15 с' },
] as const;

/** Значение по умолчанию у «Вызовов» и «Оборудования», пока человек не выбрал своё. */
export const LIVE_BY_DEFAULT = 10;

const KEY = 'zvonix.live-seconds';
const listeners = new Set<() => void>();

/**
 * Сохранённый выбор — или значение страницы, если выбора нет или он непонятен.
 *
 * Непонятный — например, вариант, которого больше нет в `LIVE_OPTIONS`: тогда действует значение страницы,
 * а не «выкл», — человек свой выбор не делал, он остался от старого кабинета.
 */
export function liveSecondsFrom(stored: string | null, pageDefault: number): number {
  if (stored === null || stored.trim() === '') return pageDefault;
  const value = Number(stored);
  return LIVE_OPTIONS.some((option) => option.seconds === value) ? value : pageDefault;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // Хранилище недоступно (приватное окно) — действует значение страницы.
    return null;
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

/** Выбор, сделанный без хранилища, — живёт до перезагрузки страницы. */
let unsaved: string | null = null;

export function setLiveSeconds(seconds: number): void {
  unsaved = String(seconds);
  try {
    window.localStorage.setItem(KEY, unsaved);
  } catch {
    // Без хранилища выбор живёт в `unsaved`: подписчиков всё равно оповещаем.
  }
  for (const listener of listeners) listener();
}

/**
 * Выбранный период в секундах; 0 — выключено. `pageDefault` — значение страницы, пока выбора нет;
 * у переключателя на той же странице оно должно быть тем же (`LiveSwitch`).
 */
export function useLiveSeconds(pageDefault = 0): number {
  return useSyncExternalStore(
    subscribe,
    () => liveSecondsFrom(readStored() ?? unsaved, pageDefault),
    () => pageDefault,
  );
}

/** Значение для `refetchInterval`: `false` — не опрашивать. */
export function useLiveInterval(pageDefault = 0): number | false {
  const seconds = useLiveSeconds(pageDefault);
  return seconds === 0 ? false : seconds * 1000;
}
