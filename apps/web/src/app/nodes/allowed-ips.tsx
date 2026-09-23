'use client';

import { DialogField } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';

/**
 * Адреса, с которых принимается токен установки.
 *
 * Поле общее у заведения и у перевыпуска, и это не экономия строк: ограничение
 * принадлежит **токену**, а не узлу, и при перевыпуске его надо задать заново.
 * Форма перевыпуска без этого поля молча снимала бы защиту, которую администратор
 * поставил при заведении, — и узнать об этом было бы неоткуда.
 */
export function AllowedIpsField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  return (
    <DialogField label="Откуда разрешена установка" hint={hint} wide>
      <Input
        className="num"
        placeholder="203.0.113.7, 2001:db8::1"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </DialogField>
  );
}

/** Адреса через запятую, точку с запятой или пробел. Годность проверяет API. */
export function parseAddresses(raw: string): string[] {
  return raw
    .split(/[\s,;]+/u)
    .map((value) => value.trim())
    .filter((value) => value !== '');
}
