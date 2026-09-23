'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { OwnerSelect } from '@/components/owner-select';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { numberFromInput } from '@/lib/money';

/**
 * Заведение клиента — кнопка и окно «Новый клиент».
 *
 * Разрешённый минус спрашивается сразу: клиент без него звонит строго на свои, а поправить
 * его потом — отдельное денежное действие с записью в журнал.
 * Значение положительное, а сравнение идёт с отрицательным остатком — хранить предел
 * со знаком минус было бы верным способом однажды раздать бесконечный кредит.
 */
export function NewClientForm() {
  return (
    <FormDialog
      label="Завести клиента"
      title="Новый клиент"
      description="Клиент заводится в состоянии «ждёт допуска»: звонки по его каналам не пойдут, пока его не переведут в «звонит»."
    >
      <NewClientFields />
    </FormDialog>
  );
}

/** Поля окна. Монтируются только открытым окном — каждое открытие начинается с пустой формы. */
function NewClientFields() {
  const queryClient = useQueryClient();
  const [ownerUserId, setOwnerUserId] = useState('');
  const [name, setName] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('0');

  const create = useMutation({
    mutationFn: () =>
      request<unknown>('/clients', {
        method: 'POST',
        body: { ownerUserId, name: name.trim(), overdraftLimit: numberFromInput(overdraftLimit) },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  return (
    <DialogForm
      submitLabel="Завести клиента"
      canSubmit={ownerUserId !== '' && name.trim().length >= 2}
      onSubmit={() => create.mutateAsync()}
    >
      <div className="sm:col-span-2">
        <OwnerSelect value={ownerUserId} onChange={setOwnerUserId} />
      </div>

      <DialogField label="Название">
        <Input
          value={name}
          autoComplete="off"
          placeholder="Такси «Первое»"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Разрешённый минус, ₽" hint="Ноль означает «только на свои».">
        <Input
          className="num"
          inputMode="decimal"
          autoComplete="off"
          value={overdraftLimit}
          onChange={(event) => {
            setOverdraftLimit(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}
