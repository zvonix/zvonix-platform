'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OwnerSelect } from '@/components/owner-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { numberFromInput } from '@/lib/money';

/**
 * Заведение клиента.
 *
 * Разрешённый минус спрашивается сразу: это единственная величина, которую нельзя
 * поменять постфактум ни одним обработчиком, и клиент без неё звонит строго на свои.
 * Значение положительное, а сравнение идёт с отрицательным остатком — хранить предел
 * со знаком минус было бы верным способом однажды раздать бесконечный кредит.
 */
export function NewClientForm() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [name, setName] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('0');

  const create = useMutation({
    mutationFn: () =>
      request<unknown>('/clients', {
        method: 'POST',
        body: { ownerUserId, name, overdraftLimit: numberFromInput(overdraftLimit) },
      }),
    onSuccess: async () => {
      setOpen(false);
      setOwnerUserId('');
      setName('');
      setOverdraftLimit('0');
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const error = create.error instanceof ApiError ? create.error : undefined;
  const ready = ownerUserId !== '' && name.trim().length >= 2;

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
          Завести клиента
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
        <OwnerSelect role="client" value={ownerUserId} onChange={setOwnerUserId} />

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Название</span>
          <Input
            className="w-[240px]"
            value={name}
            placeholder="Такси «Первое»"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Разрешённый минус, ₽</span>
          <Input
            className="num w-[140px]"
            value={overdraftLimit}
            onChange={(event) => {
              setOverdraftLimit(event.target.value);
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
        Клиент заводится в состоянии «ждёт допуска»: звонки по его каналам не пойдут, пока его не
        переведут в «звонит». Ноль в разрешённом минусе означает «только на свои».
      </p>

      {error !== undefined && <ErrorNote error={error} />}
    </form>
  );
}
