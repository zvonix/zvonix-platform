'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';

/**
 * Скопировать значение — значком с подсказкой ([DESIGN.md](../../../../docs/DESIGN.md), «Кнопки-значки»).
 * Две секунды после нажатия значок — галочка: копирование молчаливо, и без отметки непонятно, сработало ли.
 * Буфер недоступен (не https, запрет браузера) — значок не меняется, значение остаётся выделяемым рядом.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <WithTooltip label={copied ? 'Скопировано' : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-7"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 2000);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <Copy aria-hidden className="size-4" />
        )}
      </Button>
    </WithTooltip>
  );
}
