'use client';

import { MessageSquare, Phone } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Первый экран сайта: уменьшенный «кабинет» с живыми счётчиками и лентой событий (осмотр 2026-10-21: справа от заголовка
 * было пустое пятно, продукта не было видно). Это **иллюстрация**: данные выдуманные, номера замаскированы, подпись
 * «пример» стоит на виду. Для читалки экрана блок скрыт — смысл несёт текст слева. При `prefers-reduced-motion`
 * счётчики и лента стоят на месте.
 */

interface Event {
  readonly id: number;
  readonly kind: 'call' | 'message';
  readonly to: string;
  readonly detail: string;
  readonly price: string;
}

const SAMPLES: readonly Omit<Event, 'id'>[] = [
  { kind: 'call', to: '+7 916 •••-••-42', detail: 'МегаФон · 0:42', price: '1,01 ₽' },
  { kind: 'message', to: '+7 903 •••-••-17', detail: 'MAX · доставлено', price: '0,45 ₽' },
  { kind: 'call', to: '+7 925 •••-••-08', detail: 'МТС · 1:15', price: '1,80 ₽' },
  { kind: 'message', to: '+7 977 •••-••-91', detail: 'MAX · прочитано', price: '0,45 ₽' },
  { kind: 'call', to: '+7 999 •••-••-30', detail: 'Билайн · 0:27', price: '0,65 ₽' },
  { kind: 'call', to: '+7 915 •••-••-64', detail: 'Т2 · 2:03', price: '2,95 ₽' },
];

const VISIBLE = 4;
const STEP_MS = 2200;

const initial = (): Event[] => SAMPLES.slice(0, VISIBLE).map((sample, id) => ({ ...sample, id }));

export function HeroConsole() {
  const [events, setEvents] = useState<Event[]>(initial);
  const [calls, setCalls] = useState(1284);
  const [messages, setMessages] = useState(3906);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let next = VISIBLE;
    const timer = window.setInterval(() => {
      const sample = SAMPLES[next % SAMPLES.length];
      if (sample === undefined) return;
      const id = next;
      next += 1;
      setEvents((current) => [{ ...sample, id }, ...current].slice(0, VISIBLE));
      if (sample.kind === 'call') setCalls((value) => value + 1);
      else setMessages((value) => value + 1);
    }, STEP_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div aria-hidden className="site-console relative w-full max-w-md justify-self-end">
      <div className="rounded-2xl border border-border bg-card/90 p-4 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between pb-3">
          <span className="text-sm font-semibold">Сегодня</span>
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <span className="site-live-dot size-2 rounded-full bg-ok" />
            идут вызовы
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Counter label="Вызовов" value={calls.toLocaleString('ru-RU')} />
          <Counter label="Сообщений" value={messages.toLocaleString('ru-RU')} />
          <Counter label="Состоялось" value="87 %" />
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {events.map((event) => (
            <li
              key={event.id}
              className="site-console-row flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2"
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  event.kind === 'call' ? 'bg-primary/15 text-primary' : 'bg-ok/15 text-ok'
                }`}
              >
                {event.kind === 'call' ? <Phone size={14} /> : <MessageSquare size={14} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="num truncate text-sm">{event.to}</span>
                <span className="truncate text-xs text-muted-foreground">{event.detail}</span>
              </span>
              <span className="num text-sm font-medium">{event.price}</span>
            </li>
          ))}
        </ul>
      </div>
      <span className="absolute -bottom-6 right-2 text-xs text-faint">пример кабинета</span>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-2.5 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num text-lg font-semibold">{value}</div>
    </div>
  );
}
