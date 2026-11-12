'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DialogField, DialogForm } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { SipCheckReport, type SipCheck } from './sip-check';

/** Что меняется в настройках узла (ADR-0113). */
export interface NodeSettingsDraft {
  readonly name: string;
  /** Пусто — определить по пульсу узла заново. */
  readonly sipAddress: string;
}

/** Та же проверка, что у API: имя или IP, порт через двоеточие, без схемы и пути. */
const ADDRESS = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/u;

/** Сколько ждать после последнего нажатия, прежде чем спрашивать DNS. */
const CHECK_DELAY_MS = 600;

/**
 * Настройки узла АТС — окно по кнопке «Настройки» в его строке
 * ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md);
 * [DESIGN.md](../../../../../docs/DESIGN.md), «Страница объекта: что где лежит»).
 *
 * Адрес проверяется сразу, пока его вводят: есть ли запись DNS, ведёт ли она туда, где стоит узел,
 * и какую завести, если нет (владелец, 2026-11-11: «чтобы сайт сам проверял, есть запись или нет»).
 * Подтверждений внутри нет — поэтому окно, а не страница; удаление остаётся отдельной кнопкой в строке.
 */
export function NodeSettingsForm({
  nodeId,
  initial,
  onSave,
}: {
  nodeId: string;
  initial: NodeSettingsDraft;
  onSave: (draft: NodeSettingsDraft) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.sipAddress);
  const trimmedName = name.trim();
  const trimmedAddress = address.trim();
  const nameOk = trimmedName.length >= 2 && trimmedName.length <= 100;
  const addressOk = trimmedAddress === '' || ADDRESS.test(trimmedAddress);
  const changed = trimmedName !== initial.name || trimmedAddress !== initial.sipAddress;

  // Проверяется то, что введено сейчас, — не дожидаясь сохранения, но и не на каждое нажатие.
  const [checked, setChecked] = useState(trimmedAddress);
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setChecked(trimmedAddress);
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [trimmedAddress]);

  const check = useQuery({
    queryKey: ['node-sip-check', nodeId, checked, fresh],
    queryFn: () =>
      request<{ check: SipCheck }>(
        `/nodes/${nodeId}/sip-check?address=${encodeURIComponent(checked)}${fresh > 0 ? '&fresh=1' : ''}`,
      ),
    enabled: checked === '' || ADDRESS.test(checked),
    staleTime: 30_000,
  });

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
            ? 'Куда партнёры направляют GOIP, а клиенты — телефоны. Пусто — площадка определит адрес сама по сигналам узла.'
            : 'Имя или IP-адрес, без http:// и пути; порт — через двоеточие, если не 5060'
        }
      >
        <Input
          className="num"
          autoComplete="off"
          inputMode="url"
          placeholder="sip.zvonix.com"
          value={address}
          aria-invalid={!addressOk}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
      </DialogField>
      {addressOk && (
        <SipCheckReport
          check={check.data?.check}
          checking={check.isFetching || checked !== trimmedAddress}
          onRecheck={() => {
            setChecked(trimmedAddress);
            setFresh((value) => value + 1);
          }}
          onUseName={(suggested) => {
            setAddress(suggested);
          }}
        />
      )}
    </DialogForm>
  );
}
