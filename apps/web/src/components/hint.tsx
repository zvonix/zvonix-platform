'use client';

import { CircleHelp } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

/**
 * Значок «?» с пояснением в окошке: для того, что значит не очевидное слово рядом («Недоступен», «Приостановлен»).
 * В отличие от `title`, работает с клавиатуры и на телефоне: подсказка открывается нажатием и читается дикторами.
 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CircleHelp size={15} strokeWidth={2} aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="popover-content"
          align="start"
          sideOffset={6}
          className="z-50 max-w-xs rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
