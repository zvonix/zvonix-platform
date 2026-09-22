'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AllowedIpsField, parseAddresses } from './allowed-ips';

export interface NodeDraft {
  readonly name: string;
  readonly sipAddress?: string;
  readonly allowedIps: string[];
}

/**
 * Заведение узла.
 *
 * Узел заводится **до** установки: сначала запись, потом команда, которую человек
 * выполняет на сервере ([nodes.md](../../../../../docs/api/nodes.md)). Обратный порядок
 * позволял бы зарегистрировать узел, которого никто не заводил.
 */
export function NewNodeForm({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  onCreate: (draft: NodeDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [sipAddress, setSipAddress] = useState('');
  const [allowedIps, setAllowedIps] = useState('');

  const trimmedName = name.trim();
  const trimmedSip = sipAddress.trim();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmedName.length < 2) return;
        onCreate({
          name: trimmedName,
          ...(trimmedSip === '' ? {} : { sipAddress: trimmedSip }),
          allowedIps: parseAddresses(allowedIps),
        });
      }}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Имя узла</span>
          <Input
            className="w-[200px]"
            placeholder="Москва-1"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Адрес SIP для партнёров</span>
          <Input
            className="num w-[240px]"
            placeholder="sip.example.com:5060"
            value={sipAddress}
            onChange={(event) => {
              setSipAddress(event.target.value);
            }}
          />
        </label>

        <AllowedIpsField value={allowedIps} onChange={setAllowedIps} />

        <Button type="submit" size="sm" disabled={trimmedName.length < 2 || busy}>
          Завести и выдать команду
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </div>

      <p className="text-muted-foreground">
        Адрес SIP — тот, на который партнёры направляют свои GOIP. Это <b>не</b> адрес, с которого
        узел обращается к платформе. Список адресов установки необязателен, но сужает окно: токен и
        так живёт час, а с ограничением по адресу его нельзя применить с чужой машины даже в
        пределах этого часа. Несколько — через запятую.
      </p>
    </form>
  );
}
