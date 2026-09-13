'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Поле отбора с отложенной записью в адрес страницы.
 *
 * Без задержки каждое нажатие клавиши меняет адрес, а значит и ключ запроса —
 * то есть уходит новый запрос к API. На слове из десяти букв это десять запросов,
 * из которых нужен последний. Здесь набранное живёт в состоянии поля, а в адрес
 * попадает, когда человек перестал печатать.
 *
 * Задержку намеренно держим короткой: отбор должен ощущаться живым, а не «подумать
 * и показать». Триста миллисекунд — обычная пауза между словами, а не между буквами.
 */
const DELAY_MS = 300;

export function FilterInput({
  value,
  placeholder,
  className,
  onChange,
}: {
  /** Значение из адреса. Оно же побеждает при переходе «назад» и по внешней ссылке. */
  value: string;
  placeholder?: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useRef(onChange);
  notify.current = onChange;

  // Адрес изменился не отсюда — переход «назад», сброс отбора, открытие по ссылке.
  // Тогда побеждает адрес: он и есть состояние вида.
  useEffect(() => {
    setTyped(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Input
      className={className}
      placeholder={placeholder}
      value={typed}
      onChange={(event) => {
        const next = event.target.value;
        setTyped(next);
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          notify.current(next);
        }, DELAY_MS);
      }}
    />
  );
}
