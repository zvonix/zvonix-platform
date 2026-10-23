'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * Значение, которое показывается **один раз**: пароль SIP и SMPP, ключ API, команда установки узла.
 *
 * Окном поверх страницы, а не панелью в ней (владелец, 2026-10-22): панель возникала далеко от места действия, над
 * таблицей, и её не замечали, уходя со страницы вместе с единственным показом. Окно закрывается только кнопкой —
 * ни щелчок мимо, ни Esc его не убирают: закрытие здесь равносильно потере значения.
 *
 * Рамка предупреждения: это не результат действия, а последняя возможность его записать.
 */
export function OneTimeSecret({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open>
      <DialogContent
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        className="border-warn sm:max-w-[720px]"
      >
        <section
          aria-label={title}
          className="flex flex-col gap-2 overflow-y-auto rounded-xl bg-warn-soft p-4"
        >
          <div className="flex items-baseline gap-3">
            <DialogTitle className="font-semibold">{title}</DialogTitle>
            <DialogPrimitive.Close asChild>
              <Button variant="outline" size="sm" className="ml-auto" onClick={onClose}>
                Записал, закрыть
              </Button>
            </DialogPrimitive.Close>
          </div>
          {children}
        </section>
      </DialogContent>
    </Dialog>
  );
}
