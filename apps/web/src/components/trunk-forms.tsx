'use client';

import {
  DEFAULT_TRUNK_CONCURRENT_CALLS,
  MAX_TRUNK_CONCURRENT_CALLS,
  TRUNK_NUMBERS_MAX,
} from '@zvonix/shared';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import type { ApiError } from '@/lib/api';
import { integerFromInput } from '@/lib/money';

/**
 * Поля SIP-транка — одни у администратора (карточка партнёра) и у партнёра (его оборудование, ADR-0100).
 * Две копии формы разошлись бы на первой же правке проверки адреса или пароля.
 */

/** Узлы на выбор администратору. */
export interface NodeChoice {
  readonly list: readonly { readonly id: string; readonly name: string }[];
  readonly ready: boolean;
  readonly error: ApiError | undefined;
}

/** Заведение транка — поля окна «Новый транк»: адрес провайдера, способ доступа и ёмкость. */
export function NewTrunkForm({
  nodes,
  onCreate,
}: {
  /** Выбор узла — только у администратора; транку партнёра узел выбирает площадка (ADR-0100). */
  nodes?: NodeChoice;
  onCreate: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [proxyHost, setProxyHost] = useState('');
  const [registers, setRegisters] = useState(true);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [channels, setChannels] = useState(String(DEFAULT_TRUNK_CONCURRENT_CALLS));
  const [numbers, setNumbers] = useState('1');

  const channelCount = integerFromInput(channels);
  const channelsValid =
    channelCount !== undefined && channelCount >= 1 && channelCount <= MAX_TRUNK_CONCURRENT_CALLS;
  const numberCount = integerFromInput(numbers);
  const numbersValid = validNumbers(numberCount);
  const ready =
    name.trim().length >= 2 &&
    (nodes === undefined || nodeId !== '') &&
    proxyHost.trim() !== '' &&
    channelsValid &&
    numbersValid &&
    (!registers || (username.trim() !== '' && secret !== ''));

  return (
    <DialogForm
      submitLabel="Добавить"
      canSubmit={ready}
      onSubmit={() =>
        onCreate({
          ...(nodes === undefined ? {} : { nodeId }),
          name: name.trim(),
          proxyHost: proxyHost.trim(),
          registersOutbound: registers,
          ...(registers ? { outboundUsername: username.trim(), outboundSecret: secret } : {}),
          maxConcurrentCalls: channelCount,
          numbersCount: numberCount,
        })
      }
    >
      <DialogField label="Название">
        <Input
          placeholder="Транзит основной"
          autoComplete="off"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      {nodes !== undefined && (
        <DialogField label="Узел">
          <select
            value={nodeId}
            disabled={!nodes.ready}
            onChange={(event) => {
              setNodeId(event.target.value);
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2"
          >
            <option value="">{nodes.ready ? 'выберите' : 'загружаем узлы…'}</option>
            {nodes.list.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </DialogField>
      )}

      {nodes?.error !== undefined && (
        <div className="sm:col-span-2">
          <ErrorNote error={nodes.error} />
        </div>
      )}

      <DialogField label="Адрес провайдера">
        <Input
          className="num"
          placeholder="sip.provider.ru:5060"
          autoComplete="off"
          spellCheck={false}
          value={proxyHost}
          onChange={(event) => {
            setProxyHost(event.target.value);
          }}
        />
      </DialogField>

      <DialogField
        label="Каналов"
        hint={
          channelsValid ? undefined : `Целое число от 1 до ${String(MAX_TRUNK_CONCURRENT_CALLS)}.`
        }
      >
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={channels}
          onChange={(event) => {
            setChannels(event.target.value);
          }}
        />
      </DialogField>

      <NumbersField value={numbers} valid={numbersValid} onChange={setNumbers} />

      <label className="flex items-center gap-2 sm:col-span-2">
        <input
          type="checkbox"
          checked={registers}
          onChange={(event) => {
            setRegisters(event.target.checked);
          }}
        />
        <span>Регистрироваться у провайдера</span>
      </label>

      {registers && (
        <>
          <DialogField label="Имя у провайдера">
            <Input
              className="num"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </DialogField>

          <DialogField label="Пароль провайдера">
            {/*
              `new-password`: иначе браузер предложит сохранить эту пару как вход в кабинет,
              а при следующей правке сам подставит пароль кабинета в поле провайдера.
            */}
            <Input
              className="num"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
              }}
            />
          </DialogField>
        </>
      )}

      <p className="text-muted-foreground sm:col-span-2">
        Добавляется выключенным: включите, когда провайдер подтвердит доступ. Пароль после
        сохранения не показывается — его можно заменить, но не посмотреть.
      </p>
    </DialogForm>
  );
}

/**
 * Правка транка — поля окна «Настроить».
 *
 * Пустое поле пароля означает «не трогать», а не «очистить»: правка адреса не должна
 * стирать учётные данные — транк перестал бы подниматься, и увидеть это можно было бы
 * только в логе узла.
 */
export function EditTrunkForm({
  trunk,
  onSave,
}: {
  trunk: {
    readonly proxy_host: string;
    readonly max_concurrent_calls: number;
    readonly numbers_count: number;
  };
  onSave: (changes: Record<string, unknown>) => Promise<unknown>;
}) {
  const [proxyHost, setProxyHost] = useState(trunk.proxy_host);
  const [channels, setChannels] = useState(String(trunk.max_concurrent_calls));
  const [numbers, setNumbers] = useState(String(trunk.numbers_count));
  const [secret, setSecret] = useState('');

  const channelCount = integerFromInput(channels);
  const channelsValid =
    channelCount !== undefined && channelCount >= 1 && channelCount <= MAX_TRUNK_CONCURRENT_CALLS;

  const changes: Record<string, unknown> = {};
  if (proxyHost.trim() !== trunk.proxy_host) changes.proxyHost = proxyHost.trim();
  if (channelsValid && channelCount !== trunk.max_concurrent_calls) {
    changes.maxConcurrentCalls = channelCount;
  }
  const numberCount = integerFromInput(numbers);
  const numbersValid = validNumbers(numberCount);
  if (numbersValid && numberCount !== trunk.numbers_count) changes.numbersCount = numberCount;
  if (secret !== '') changes.outboundSecret = secret;
  const dirty = Object.keys(changes).length > 0;

  return (
    <DialogForm
      submitLabel="Сохранить"
      canSubmit={dirty && channelsValid && numbersValid}
      onSubmit={() => onSave(changes)}
    >
      <DialogField label="Адрес провайдера">
        <Input
          className="num"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={proxyHost}
          onChange={(event) => {
            setProxyHost(event.target.value);
          }}
        />
      </DialogField>

      <DialogField
        label="Каналов"
        hint={
          channelsValid ? undefined : `Целое число от 1 до ${String(MAX_TRUNK_CONCURRENT_CALLS)}.`
        }
      >
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={channels}
          onChange={(event) => {
            setChannels(event.target.value);
          }}
        />
      </DialogField>

      <NumbersField value={numbers} valid={numbersValid} onChange={setNumbers} />

      <DialogField label="Новый пароль провайдера" hint="Пусто — пароль остаётся прежним." wide>
        <Input
          className="num"
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}

function validNumbers(count: number | undefined): count is number {
  return count !== undefined && count >= 1 && count <= TRUNK_NUMBERS_MAX;
}

/** Номеров у провайдера: рекомендованная работа и прогрев считаются на номер (ADR-0105). */
function NumbersField({
  value,
  valid,
  onChange,
}: {
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <DialogField
      label="Номеров у провайдера"
      hint={
        valid
          ? 'Предел звонков с одного номера умножится на это число.'
          : `Целое число от 1 до ${String(TRUNK_NUMBERS_MAX)}.`
      }
    >
      <Input
        className="num"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </DialogField>
  );
}
