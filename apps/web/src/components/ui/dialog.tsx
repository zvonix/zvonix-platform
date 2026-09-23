'use client';

import * as React from 'react';
import { cn } from 'cn';
import { Dialog as DialogPrimitive } from 'radix-ui';

/**
 * Окно по центру — примитивы Radix под образец кабинетов
 * ([prototype/cabinets](../../../../../docs/prototype/cabinets/README.md), «Партнёры»).
 *
 * Взято из реестра shadcn (стиль new-york) и изменено так же, как `alert-dialog`: без
 * анимаций, подложка цветом палитры. Плюс два отличия от образца shadcn:
 * - **щелчок мимо окно не закрывает** — в нём поля, и случайный щелчок терял бы
 *   введённое ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница или панель»).
 *   Закрывают крестик, «Отмена» и Escape;
 * - высота ограничена экраном, прокручивается тело окна, а заголовок и кнопки остаются
 *   на месте: на телефоне форма из шести полей выше экрана.
 */

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogContent({
  className,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-foreground/40"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card text-card-foreground shadow-lg sm:max-w-[560px]',
          className,
        )}
        onInteractOutside={(event) => {
          event.preventDefault();
          onInteractOutside?.(event);
        }}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg font-semibold text-balance', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger };
