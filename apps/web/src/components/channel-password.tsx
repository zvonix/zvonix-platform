'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/copy-button';
import { ErrorNote } from '@/components/error-note';
import { PasswordInput } from '@/components/ui/password-input';
import { ApiError, request } from '@/lib/api';

/**
 * Пароль линии клиента — по «глазу» ([ADR-0124](../../../../docs/adr/0124-vosstanovimyy-parol-linii-klienta.md)):
 * одно и то же поле у клиента (страница линии) и у администратора (настройки канала). Пароль загружается только
 * по нажатию, и каждый показ попадает в журнал. Поэтому при каждом «показать» запрос идёт заново: после «Нового
 * пароля» показывается уже новый.
 *
 * Пароль, выданный до обновления, не хранится — одна фраза, без подсказок.
 */
export function ChannelPassword({ endpoint, hasSecret }: { endpoint: string; hasSecret: boolean }) {
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  if (!hasSecret) {
    return (
      <span className="text-muted-foreground">
        пароль выдан до обновления — посмотреть нельзя, выпустите новый
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1">
        <PasswordInput
          readOnly
          aria-label="Пароль линии"
          className="num w-56"
          autoComplete="off"
          placeholder="••••••••"
          value={password ?? ''}
          onShow={() => {
            setError(undefined);
            request<{ password: string | null }>(endpoint).then(
              (reply) => {
                setPassword(reply.password);
              },
              (cause: unknown) => {
                if (cause instanceof ApiError) setError(cause);
                else throw cause;
              },
            );
          }}
        />
        {typeof password === 'string' && <CopyButton value={password} label="Скопировать пароль" />}
      </span>
      {password === null && (
        <span className="text-muted-foreground">
          пароль выдан до обновления — посмотреть нельзя, выпустите новый
        </span>
      )}
      {error !== undefined && <ErrorNote error={error} />}
    </span>
  );
}
