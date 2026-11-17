'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Поле пароля со значком «показать» (владелец, 2026-11-17: «сделать, чтобы можно было увидеть введённый пароль»).
 * Показывает только набранное сейчас: сохранённый пароль площадка не отдаёт никому.
 */
export function PasswordInput({
  className = '',
  ...props
}: Omit<ComponentProps<typeof Input>, 'type'>) {
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
          setShown((value) => !value);
        }}
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
