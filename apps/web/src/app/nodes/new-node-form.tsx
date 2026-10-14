'use client';

import { useEffect, useState } from 'react';
import { DialogField, DialogForm } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AllowedIpsField, parseAddresses } from './allowed-ips';

export interface NodeDraft {
  readonly name: string;
  readonly sipAddress?: string;
  readonly allowedIps: string[];
}

/**
 * Заведение узла — поля окна «Новый узел».
 *
 * Узел заводится **до** установки: сначала запись, потом команда, которую человек
 * выполняет на сервере ([nodes.md](../../../../../docs/api/nodes.md)). Обратный порядок
 * позволял бы зарегистрировать узел, которого никто не заводил.
 */
export function NewNodeForm({ onCreate }: { onCreate: (draft: NodeDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [sipAddress, setSipAddress] = useState('');
  const [allowedIps, setAllowedIps] = useState('');
  // Кабинет открыт по `cp.<домен>`, значит, адрес SIP по тому же соглашению — `sip.<домен>`: имя,
  // а не IP, чтобы при смене сервера узла хватило одной записи DNS. Определяется в браузере.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => {
    const match = /^cp\.(.+)$/u.exec(window.location.hostname);
    if (match?.[1] !== undefined) setSuggestion(`sip.${match[1]}:5060`);
  }, []);

  const trimmedName = name.trim();
  const trimmedSip = sipAddress.trim();

  return (
    <DialogForm
      submitLabel="Добавить и выдать команду"
      canSubmit={trimmedName.length >= 2}
      onSubmit={() =>
        onCreate({
          name: trimmedName,
          ...(trimmedSip === '' ? {} : { sipAddress: trimmedSip }),
          allowedIps: parseAddresses(allowedIps),
        })
      }
    >
      <DialogField label="Имя узла">
        <Input
          placeholder="Москва-1"
          value={name}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Адрес SIP для партнёров">
        <Input
          className="num"
          placeholder={suggestion ?? 'sip.example.com:5060'}
          value={sipAddress}
          onChange={(event) => {
            setSipAddress(event.target.value);
          }}
        />
      </DialogField>

      <div className="flex flex-col gap-2 text-muted-foreground sm:col-span-2">
        <p>
          Адрес SIP — тот, на который партнёры направляют свои GOIP. Это <b>не</b> адрес, с которого
          узел обращается к платформе. Лучше имя, чем IP: при смене сервера достаточно поменять
          запись DNS, а партнёрам ничего перенастраивать не придётся.
        </p>
        {suggestion !== null && sipAddress === '' && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setSipAddress(suggestion);
              }}
            >
              Подставить {suggestion}
            </Button>
          </div>
        )}
      </div>

      <AllowedIpsField
        value={allowedIps}
        onChange={setAllowedIps}
        hint="Необязательно, но сужает окно: токен и так живёт час, а с ограничением по адресу его нельзя применить с чужой машины даже в пределах этого часа. Несколько — через запятую."
      />
    </DialogForm>
  );
}
