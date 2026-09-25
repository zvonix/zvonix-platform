'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';

/**
 * Короткое действие с полями — окно по центру ([DESIGN.md](../../../../docs/DESIGN.md),
 * «Окно, страница или панель»): завести узел, переименовать, пополнить. Раньше такие
 * формы раскрывались посреди страницы или строкой таблицы и сдвигали список.
 *
 * Делится на две части, потому что поля принадлежат форме, а окно — странице:
 * - `FormDialog` — кнопка и окно. Содержимое монтируется только открытым, поэтому
 *   каждое открытие начинается с пустой формы, а закрытое не держит набранного;
 * - `DialogForm` — сама форма внутри: поля в две колонки, отказ, кнопки.
 *
 * Поведение то же, что у `ConfirmAction`: пока идёт запрос, окно не закрывается и второй
 * раз не отправляет; отказ показывается в окне; успех закрывает окно.
 */

interface DialogState {
  readonly close: () => void;
  readonly setPending: (pending: boolean) => void;
}

const DialogContext = createContext<DialogState | undefined>(undefined);

export function FormDialog({
  label,
  title,
  description,
  open: controlledOpen,
  onOpenChange,
  variant = 'default',
  size = 'sm',
  disabled = false,
  className,
  wide = false,
  children,
}: {
  /** Подпись кнопки, открывающей окно. Без неё окно открывает вызывающий через `open`. */
  label?: ReactNode;
  title: string;
  /** Одна строка под заголовком: чей это объект и что сейчас. */
  description?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: 'outline' | 'default' | 'secondary' | 'ghost';
  size?: 'xs' | 'sm' | 'default';
  disabled?: boolean;
  className?: string;
  /** Шире обычного — для таблицы внутри окна, например портов шлюза. */
  wide?: boolean;
  children: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const open = controlledOpen ?? ownOpen;

  const change = (next: boolean): void => {
    if (pending) return;
    setOwnOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      {label !== undefined && (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            disabled={disabled}
            className={className}
          >
            {label}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className={wide ? 'sm:max-w-[760px]' : undefined}>
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>{title}</DialogTitle>
            {description === undefined ? (
              // Radix требует описание или явный отказ от него, иначе предупреждает в консоли.
              <DialogDescription className="sr-only">{title}</DialogDescription>
            ) : (
              <DialogDescription asChild>
                <div>{description}</div>
              </DialogDescription>
            )}
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Закрыть"
              aria-disabled={pending}
              className="ml-auto size-8 shrink-0 p-0 aria-disabled:opacity-50"
            >
              ×
            </Button>
          </DialogClose>
        </div>

        <DialogContext.Provider
          value={{
            close: () => {
              setOwnOpen(false);
              onOpenChange?.(false);
            },
            setPending,
          }}
        >
          {children}
        </DialogContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

export function DialogForm({
  submitLabel,
  canSubmit = true,
  onSubmit,
  tone = 'default',
  keepOpen = false,
  children,
}: {
  /** Называет действие: «Добавить узел», а не «Сохранить». */
  submitLabel: string;
  /** Обязательные поля не заполнены — кнопка недоступна, а не отказ после нажатия. */
  canSubmit?: boolean;
  /** Запрос. Отказ показывается в окне, успех закрывает его. */
  onSubmit: () => Promise<unknown>;
  tone?: 'default' | 'danger';
  /**
   * Успех не закрывает окно: итог действия показывается в нём же — так у тестового
   * звонка, где после отправки ещё идёт дозвон.
   */
  keepOpen?: boolean;
  /** Поля. Сетка в две колонки; широкое поле — `sm:col-span-2`. */
  children: ReactNode;
}) {
  const dialog = useContext(DialogContext);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiError | undefined>(undefined);
  if (dialog === undefined) throw new Error('DialogForm живёт только внутри FormDialog');

  async function submit(): Promise<void> {
    if (pending || !canSubmit || dialog === undefined) return;
    setPending(true);
    dialog.setPending(true);
    setFailure(undefined);
    try {
      await onSubmit();
      dialog.setPending(false);
      if (!keepOpen) dialog.close();
    } catch (error) {
      if (error instanceof ApiError) {
        setFailure(error);
      } else {
        // Не отказ API, а сбой в самом кабинете: человеку — общее сообщение,
        // разбирающему — исходная ошибка в консоли.
        console.error(error);
        setFailure(new ApiError('internal', 'Действие не выполнено', 0, {}, undefined));
      }
      dialog.setPending(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        {children}
        {failure !== undefined && (
          <div className="sm:col-span-2">
            <ErrorNote error={failure} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <Button
          type="submit"
          size="sm"
          variant={tone === 'danger' ? 'destructive' : 'default'}
          disabled={!canSubmit}
          aria-disabled={pending}
          className="aria-disabled:opacity-50"
        >
          {pending ? 'Выполняем…' : submitLabel}
        </Button>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={pending}
            className="aria-disabled:opacity-50"
          >
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}

/** Поле формы в окне: подпись над полем и необязательная подсказка под ним. */
export function DialogField({
  label,
  hint,
  wide = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** На обе колонки: длинное поле или поле с объяснением. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
