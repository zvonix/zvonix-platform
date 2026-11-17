'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';

/** Цвет состояния: работает, требует внимания, авария, выключено или неважно сейчас. */
export type StatusTone = 'ok' | 'warn' | 'crit' | 'off';

/**
 * Тон точки из классов прежней метки (`bg-ok-soft text-ok` из `lib/labels.ts`): помощники цвета состояния остаются
 * одни на кабинет, а таблица рисует их точкой, а не плашкой.
 */
export function toneOf(classes: string): StatusTone {
  if (classes.includes('text-ok')) return 'ok';
  if (classes.includes('text-warn')) return 'warn';
  if (classes.includes('text-crit')) return 'crit';
  return 'off';
}

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
 * несколько строк»). Слово рядом с точкой — там, где состояние надо прочесть с первого взгляда.
 *
 * `dotOnly` — одна точка, слово уходит в подсказку: для столбца, где повтор слова в каждой строке ничего не добавляет
 * (связь линии; владелец, 2026-11-17: «не на связи помечать жёлтым значком, без надписи; при наведении — пояснение»).
 * Тогда подсказка есть всегда, а цель нажатия — 24 px вокруг точки.
 */
export function StatusDot({
  tone,
  label,
  reason,
  dotOnly = false,
  phoneDot = false,
}: {
  tone: StatusTone;
  label: string;
  reason?: string | undefined;
  dotOnly?: boolean;
  /** На телефоне — только точка, слово в подсказке: иначе рубильник в конце строки уезжает за край. */
  phoneDot?: boolean;
}) {
  const dot = <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />;
  const why = reason ?? '';
  const hasReason = why !== '';
  if (dotOnly) {
    return (
      <TipTrigger
        tip={hasReason ? `${label}: ${why}` : label}
        className="inline-flex size-6 items-center justify-center"
      >
        {dot}
      </TipTrigger>
    );
  }
  const className = `inline-flex items-center gap-1.5 whitespace-nowrap ${TEXT[tone]}`;
  const body = (
    <>
      {dot}
      {phoneDot ? <span className="hidden md:inline">{label}</span> : label}
    </>
  );
  if (!hasReason && !phoneDot) return <span className={className}>{body}</span>;
  const full = hasReason ? `${label}: ${why}` : label;
  return (
    <TipTrigger
      tip={phoneDot ? full : why}
      label={full}
      className={
        phoneDot ? `${className} min-h-6 min-w-6 justify-center md:justify-start` : className
      }
    >
      {body}
    </TipTrigger>
  );
}

/** Короткий текст ячейки с пояснением в подсказке — «4/14» в столбце «Прогрев». */
export function HintText({ label, reason }: { label: string; reason: string }) {
  return (
    <TipTrigger tip={reason} label={`${label}: ${reason}`} className="num whitespace-nowrap">
      {label}
    </TipTrigger>
  );
}

/**
 * Имя или текст, обрезанный по ширине столбца, — целиком и с подробностями в подсказке (почта и телефон заявителя,
 * модель шлюза, комментарий линии). В отличие от `title`, открывается нажатием на телефоне и с клавиатуры.
 * `width` — класс наибольшей ширины (`max-w-56`).
 */
export function ClippedText({
  text,
  hint,
  width = 'max-w-56',
}: {
  text: string;
  /** Что показать в подсказке; пусто — сам текст целиком. */
  hint?: string | null | undefined;
  width?: string;
}) {
  const tip = hint === undefined || hint === null || hint === '' ? text : hint;
  return (
    <TipTrigger
      tip={tip}
      label={tip === text ? text : `${text}: ${tip}`}
      className={`inline-block truncate text-left align-bottom ${width}`}
    >
      {text}
    </TipTrigger>
  );
}

/**
 * Подсказка открывается наведением, фокусом с клавиатуры **и нажатием** — на телефоне наведения нет, а причина
 * («неверный пароль») там нужнее всего.
 */
function TipTrigger({
  tip,
  label,
  className,
  children,
}: {
  tip: string;
  label?: string;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={label ?? tip}
            className={`${className} cursor-help rounded-sm focus-visible:outline-2 focus-visible:outline-ring`}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {children}
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-xs rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md"
          >
            {tip}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
