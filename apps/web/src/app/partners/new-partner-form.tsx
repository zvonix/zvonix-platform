'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OwnerSelect } from '@/components/owner-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';

/**
 * Заведение партнёра.
 *
 * Псевдоним — единственное, что о партнёре узнает клиент
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)), поэтому
 * он спрашивается сразу и намекать на личность не должен.
 */
export function NewPartnerForm() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      request<unknown>('/partners', {
        method: 'POST',
        body: { ownerUserId, name, displayName },
      }),
    onSuccess: async () => {
      setOpen(false);
      setOwnerUserId('');
      setName('');
      setDisplayName('');
      await queryClient.invalidateQueries({ queryKey: ['partners'] });
    },
  });

  const error = create.error instanceof ApiError ? create.error : undefined;
  const ready = ownerUserId !== '' && name.trim().length >= 2 && displayName.trim().length >= 2;

  if (!open) {
    return (
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          Завести партнёра
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <OwnerSelect role="partner" value={ownerUserId} onChange={setOwnerUserId} />

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Настоящее имя</span>
          <Input
            className="w-[240px]"
            value={name}
            placeholder="Иванов Иван Иванович"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Псевдоним у клиента</span>
          <Input
            className="w-[200px]"
            value={displayName}
            placeholder="Партнёр 17"
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
        </label>

        <Button type="submit" size="sm" disabled={!ready || create.isPending}>
          Завести
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
          }}
        >
          Отменить
        </Button>
      </div>

      <p className="text-muted-foreground">
        Партнёр заводится в состоянии «ждёт проверки»: трафик по нему не пойдёт, пока его не
        переведут в «проверен». Настоящее имя клиенту не показывается никогда — он видит только
        псевдоним.
      </p>

      {error !== undefined && (
        <p role="alert" className="text-crit">
          {error.message}
        </p>
      )}
    </form>
  );
}
