'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useState } from 'react';

/** Цвет состояния: работает, требует внимания, авария, выключено или неважно сейчас. */
export type StatusTone = 'ok' | 'warn' | 'crit' | 'off';

const DOT: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  off: 'bg-faint',
};

const TEXT: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  off: 'text-muted-foreground',
};

/**
 * Состояние в строке таблицы — точка и одно-два слова, причина и подробности в подсказке
 * ([DESIGN.md](../../../../docs/DESIGN.md), «Таблица»; владелец, 2026-11-17: «много ненужной информации, всё в
 * несколько строк»). Слово остаётся рядом с точкой: один цвет не читается при нарушенном цветовосприятии.
 *
 * Подсказка открывается наведением, фокусом с клавиатуры **и нажатием** — на телефоне наведения нет, а причина
 * («неверный пароль») там нужнее всего. Без причины это простой текст, без лишней остановки `Tab`.
 */
export function StatusDot({
  tone,
  label,
  reason,
}: {
  tone: StatusTone;
  label: string;
  reason?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
      {label}
    </>
  );
  const className = `inline-flex items-center gap-1.5 whitespace-nowrap ${TEXT[tone]}`;
  if (reason === undefined || reason === '') return <span className={className}>{body}</span>;

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${reason}`}
            className={`${className} cursor-help rounded-sm focus-visible:outline-2 focus-visible:outline-ring`}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {body}
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-xs rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md"
          >
            {reason}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
