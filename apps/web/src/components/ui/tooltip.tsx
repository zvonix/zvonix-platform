'use client';

import type { ReactElement } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

/**
 * Подсказка при наведении и при фокусе с клавиатуры — к кнопке-значку, у которой нет подписи на экране
 * ([DESIGN.md](../../../../../docs/DESIGN.md), «Кнопки-значки»). Название кнопки для диктора даёт её `aria-label`,
 * подсказка лишь показывает его зрячему; на телефоне наведения нет — поэтому значок берётся только узнаваемый.
 *
 * Своя обёртка с поставщиком внутри, как у shadcn: подсказок на странице немного, общий поставщик не нужен.
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 rounded-md border border-border bg-card px-2 py-1 text-xs whitespace-nowrap text-card-foreground shadow-md"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/** Подсказка, только если она задана: кнопка с подписью на экране подсказки не получает. */
export function WithTooltip({
  label,
  children,
}: {
  label: string | undefined;
  children: ReactElement;
}) {
  return label === undefined ? children : <Tooltip label={label}>{children}</Tooltip>;
}
