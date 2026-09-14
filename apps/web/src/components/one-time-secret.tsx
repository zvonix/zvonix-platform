'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Панель со значением, которое показывается **один раз**.
 *
 * Таких значений в системе два рода — пароль SIP и команда установки узла, — и общее
 * у них не оформление, а поведение: панель не сворачивается сама и не исчезает при
 * обновлении списка. Закрыть её должен человек, потому что закрытие здесь равносильно
 * потере значения.
 *
 * Рамка предупреждения, а не обычная карточка: это не результат действия, а последняя
 * возможность его записать.
 *
 * При появлении панель прокручивается в поле зрения и берёт фокус: она может возникнуть
 * далеко от места действия — над таблицей, пока форма была внизу раскрытой строки, — и
 * человек, не увидев её, уходил со страницы вместе с единственным показом значения.
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: 'nearest' });
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label={title}
      tabIndex={-1}
      className="flex max-w-[720px] flex-col gap-2 rounded-md border border-warn bg-warn-soft p-3 outline-none"
    >
      <div className="flex items-baseline gap-3">
        <h4 className="font-semibold">{title}</h4>
        <Button variant="outline" size="sm" className="ml-auto" onClick={onClose}>
          Записал, закрыть
        </Button>
      </div>
      {children}
    </div>
  );
}
