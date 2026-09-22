'use client';

import { useRef, useState, type ReactNode } from 'react';
import { ErrorNote } from '@/components/error-note';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';

/**
 * Опасное действие с подтверждением ([DESIGN.md](../../../../docs/DESIGN.md), «Опасные действия»).
 *
 * Спрашивается, когда действие **необратимо, останавливает трафик, двигает деньги или
 * снимает защиту**. Окно называет действие и последствие, а не «вы уверены?».
 *
 * Единственный способ подтверждения в кабинете. До него было три самодельных, и у двух
 * взведённая кнопка не сбрасывалась никогда, а двойной щелчок проходил оба шага сразу
 * (ui-review, 2026-09-14). Здесь фокус, Escape и возврат фокуса дают примитивы Radix.
 *
 * - Пока идёт запрос, окно не закрывается ни отменой, ни Escape, и второй раз
 *   не отправляется: у правил наценки и коридоров второй запрос — вторая запись.
 * - Кнопки окна на это время не выключаются, а помечаются `aria-disabled`: выключенная
 *   кнопка теряет фокус, и после отказа он оказывался вне окна.
 * - Отказ показывается в самом окне. Вызывающему не нужно дублировать его на странице.
 * - Успех закрывает окно. Обновление экрана — дело вызывающего.
 * - Кнопка, открывающая окно, — `AlertDialogTrigger`: диктор объявляет, что она открывает
 *   окно, а после закрытия фокус возвращается на неё.
 * - **Кнопки к закрытию может уже не быть**: списанный шлюз уходит из списка, свёрнутая
 *   правка уносит свою кнопку, выполненное действие делает её недоступной. Тогда фокус
 *   встаёт на первый доступный элемент в ближайшем уцелевшем месте, где кнопка стояла, —
 *   иначе он падал на страницу, и клавиатуре с диктором приходилось искать место заново.
 *   Вызывающий для этого ждёт обновления экрана в `onSuccess`: окно закрывается, когда
 *   на экране уже новое состояние.
 * - Роль не проверяется: действие, недоступное роли, вызывающий просто не рисует.
 */
/** Что может принять фокус: доступное и не исключённое из обхода клавиатурой. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmAction({
  label,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  tone = 'danger',
  variant = 'outline',
  size = 'sm',
  disabled = false,
  className,
}: {
  /** Подпись кнопки, открывающей окно. */
  label: ReactNode;
  /** Действие и его объект: «Вывести узел msk-1 из эксплуатации». */
  title: string;
  /** Что случится. Ради этого текста окно и существует. */
  consequence: ReactNode;
  /** Подпись подтверждения — называет действие, а не «ОК». */
  confirmLabel: string;
  /** Запрос. Отказ показывается в окне, успех закрывает его. */
  onConfirm: () => Promise<unknown>;
  /**
   * `danger` — необратимое или останавливающее трафик: подтверждение красное.
   * `neutral` — остальное, что всё же стоит спросить: деньги, обращения.
   */
  tone?: 'danger' | 'neutral';
  variant?: 'outline' | 'default' | 'secondary' | 'ghost';
  size?: 'xs' | 'sm' | 'default';
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiError | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Предки кнопки на момент открытия: сама кнопка может исчезнуть вместе с тем, что
  // подтверждали, а фокус должен остаться рядом с этим местом.
  const placeRef = useRef<HTMLElement[]>([]);

  function rememberPlace(): void {
    const chain: HTMLElement[] = [];
    for (
      let node = triggerRef.current?.parentElement ?? null;
      node !== null && node !== document.body;
      node = node.parentElement
    ) {
      chain.push(node);
    }
    placeRef.current = chain;
  }

  /**
   * Возврат фокуса после закрытия.
   *
   * Кнопка на месте и доступна — фокус возвращает Radix. Иначе — первый доступный
   * элемент в ближайшем уцелевшем предке. Срабатывает и тогда, когда вместе с кнопкой
   * размонтировалось всё окно: Radix вызывает обработчик при снятии ловушки фокуса.
   */
  function returnFocus(event: Event): void {
    const trigger = triggerRef.current;
    if (trigger !== null && trigger.isConnected && !trigger.disabled) return;
    event.preventDefault();
    for (const place of placeRef.current) {
      if (!place.isConnected) continue;
      for (const candidate of place.querySelectorAll<HTMLElement>(FOCUSABLE)) {
        // Скрытое фокус не принимает, и `focus()` на нём молча ничего не делает.
        if (candidate.closest('[hidden], [inert]') !== null) continue;
        if (candidate.getClientRects().length === 0) continue;
        candidate.focus();
        if (document.activeElement === candidate) return;
      }
    }
  }

  async function confirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    setFailure(undefined);
    try {
      await onConfirm();
      setOpen(false);
    } catch (error) {
      if (error instanceof ApiError) {
        setFailure(error);
      } else {
        // Не отказ API, а сбой в самом кабинете: человеку — общее сообщение,
        // разбирающему — исходная ошибка в консоли, иначе от неё не остаётся следа.
        console.error(error);
        setFailure(new ApiError('internal', 'Действие не выполнено', 0, {}, undefined));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) rememberPlace();
        setOpen(next);
        setFailure(undefined);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant={variant}
          size={size}
          disabled={disabled}
          className={className}
        >
          {label}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">{consequence}</div>
        </AlertDialogDescription>

        {failure !== undefined && <ErrorNote error={failure} />}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <AlertDialogCancel asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={pending}
              className="aria-disabled:opacity-50"
            >
              Отмена
            </Button>
          </AlertDialogCancel>
          <Button
            type="button"
            size="sm"
            variant={tone === 'danger' ? 'destructive' : 'default'}
            aria-disabled={pending}
            className="aria-disabled:opacity-50"
            onClick={() => {
              void confirm();
            }}
          >
            {pending ? 'Выполняем…' : confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
