'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { OwnerSelect } from '@/components/owner-select';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';

interface Created {
  readonly partner: { readonly id: string };
}

/**
 * Заведение партнёра — кнопка «Добавить партнёра» и окно с тремя полями
 * ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница или панель»).
 *
 * Псевдоним — единственное, что о партнёре узнает клиент
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)), поэтому
 * он спрашивается сразу и намекать на личность не должен.
 *
 * После добавления кабинет переходит на карточку нового партнёра: без шлюза, SIM, цен
 * и допуска к работе партнёр не звонит, и всё это заводится именно там.
 */
export function NewPartnerForm() {
  return (
    <FormDialog
      label="Добавить партнёра"
      title="Новый партнёр"
      description="Создаётся в состоянии «ждёт проверки»: трафик по нему не пойдёт, пока его не допустят к работе."
    >
      <NewPartnerFields />
    </FormDialog>
  );
}

function NewPartnerFields() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [ownerUserId, setOwnerUserId] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      request<Created>('/partners', {
        method: 'POST',
        body: { ownerUserId, name: name.trim(), displayName: displayName.trim() },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['partners'] });
      router.push(`/partners/${created.partner.id}`);
    },
  });

  const ready = ownerUserId !== '' && name.trim().length >= 2 && displayName.trim().length >= 2;

  return (
    <DialogForm
      submitLabel="Добавить партнёра"
      canSubmit={ready}
      onSubmit={() => create.mutateAsync()}
    >
      <div className="sm:col-span-2">
        <OwnerSelect value={ownerUserId} onChange={setOwnerUserId} />
      </div>

      <DialogField label="Настоящее имя">
        <Input
          value={name}
          placeholder="Иванов Иван Иванович"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Псевдоним у клиента">
        <Input
          value={displayName}
          autoComplete="off"
          placeholder="Партнёр 17"
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
      </DialogField>

      <p className="text-muted-foreground sm:col-span-2">
        Настоящее имя клиенту не показывается никогда — он видит только псевдоним.
      </p>
    </DialogForm>
  );
}
