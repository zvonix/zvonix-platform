'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Поле пароля со значком «показать» (владелец, 2026-11-17: «кнопку показать пароль и при необходимости изменить»).
 * `onShow` — первое «показать»: подгрузить сохранённый пароль, если поле его ещё не знает.
 */
export function PasswordInput({
  className = '',
  onShow,
  ...props
}: Omit<ComponentProps<typeof Input>, 'type'> & { onShow?: () => void }) {
  const [shown, setShown] = useState(false);
  const label = shown ? 'Скрыть пароль' : 'Показать пароль';
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={`pr-9 ${className}`.trim()} />
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        onClick={() => {
          if (!shown) onShow?.();
          setShown(!shown);
        }}
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
