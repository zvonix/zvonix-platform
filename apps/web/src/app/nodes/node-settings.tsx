'use client';

import { useState } from 'react';
import { DialogField, DialogForm } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';

/** Что меняется в настройках узла (ADR-0113). */
export interface NodeSettingsDraft {
  readonly name: string;
  /** Пусто — определить по пульсу узла заново. */
  readonly sipAddress: string;
}

/**
 * Настройки узла АТС — окно по кнопке «Настройки» в его строке
 * ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md);
 * [DESIGN.md](../../../../../docs/DESIGN.md), «Страница объекта: что где лежит»).
 *
 * Раньше адрес SIP задавался только при добавлении узла, и узел без адреса так и оставался без него:
 * кабинет подставлял партнёрам домен сайта, и GOIP уходил на машину без телефонии (владелец, 2026-11-11).
 * Подтверждений внутри нет — поэтому окно, а не страница; удаление остаётся отдельной кнопкой в строке.
 */
export function NodeSettingsForm({
  initial,
  onSave,
}: {
  initial: NodeSettingsDraft;
  onSave: (draft: NodeSettingsDraft) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.sipAddress);
  const trimmedName = name.trim();
  const trimmedAddress = address.trim();
  const nameOk = trimmedName.length >= 2 && trimmedName.length <= 100;
  // Та же проверка, что у API: имя или IP, порт через двоеточие, без схемы и пути.
  const addressOk =
    trimmedAddress === '' ||
    /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/u.test(trimmedAddress);
  const changed = trimmedName !== initial.name || trimmedAddress !== initial.sipAddress;

  return (
    <DialogForm
      submitLabel="Сохранить"
      canSubmit={nameOk && addressOk && changed}
      onSubmit={() => onSave({ name: trimmedName, sipAddress: trimmedAddress })}
    >
      <DialogField label="Название" hint="Как узел называется в кабинете: «Москва-1»">
        <Input
          autoComplete="off"
          value={name}
          aria-invalid={!nameOk}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>
      <DialogField
        label="Адрес SIP"
        hint={
          addressOk
            ? 'Куда партнёры направляют GOIP, а клиенты — телефоны. Оставьте пустым — площадка определит его сама по сигналам узла.'
            : 'Имя или IP-адрес, без http:// и пути; порт — через двоеточие, если не 5060'
        }
      >
        <Input
          className="num"
          autoComplete="off"
          inputMode="url"
          placeholder="определится сам"
          value={address}
          aria-invalid={!addressOk}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}
