'use client';

import * as React from 'react';
import { cn } from 'cn';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

/**
 * Окно подтверждения — примитивы Radix под стиль кабинета.
 *
 * Взято из реестра shadcn (стиль new-york) и изменено в трёх местах. Без анимаций —
 * в рабочих экранах их нет ([DESIGN.md](../../../../../docs/DESIGN.md)). Подложка цветом
 * палитры, а не чёрным: цвет берётся только через токен. И без кнопок действия:
 * `Action` из Radix закрывает окно по нажатию, отказ запроса пропадал бы вместе с ним,
 * а повторное нажатие отправляло бы второй запрос. Кнопки собирает `ConfirmAction`.
 */

function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-50 bg-foreground/40"
      />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg sm:max-w-md',
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-[15px] font-semibold text-balance', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

function AlertDialogCancel(props: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" {...props} />;
}

export {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
};
