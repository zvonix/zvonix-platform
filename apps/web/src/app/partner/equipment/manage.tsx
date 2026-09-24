'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { SipCredentials, type SipAccount } from '@/components/sip-credentials';
import { StatusDialog, type StatusOption } from '@/components/status-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { integerFromInput } from '@/lib/money';
import { EQUIPMENT_KEY, gatewayStateName, type Gateway, type Sim } from './equipment';

/**
 * Действия партнёра над своим оборудованием
 * ([ADR-0043](../../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
 *
 * Отдельным файлом от страниц: те показывают состояние, этот — меняет его.
 * Все обращения идут в собственный контур `/partner/*`: идентификатор партнёра там
 * выводится из сессии, и подставить чужой нечего.
 *
 * Слова — «добавить» и «удалить», а не «завести» и «списать»: так называют действие
 * в любом другом интерфейсе, и партнёр не должен переводить канцелярит (владелец,
 * 2026-09-24).
 */

/** Номер порта и число портов — в тех же пределах, что у API. */
const MAX_PORTS = 256;

/** Общий хвост любого действия: перечитать оборудование целиком. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: EQUIPMENT_KEY });
  };
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Добавление шлюза. Пароль SIP показывается здесь и один раз, рядом — ссылка
 * на страницу шлюза, где остальные настройки видны всегда.
 */
export function AddGateway() {
  const refresh = useRefresh();
  const [created, setCreated] = useState<{ id: string; account: SipAccount } | undefined>(
    undefined,
  );

  const add = useMutation({
    mutationFn: (draft: GatewayDraft) =>
      request<{ gateway: { id: string }; account: SipAccount }>('/partner/gateways', {
        method: 'POST',
        body: { ...draft },
      }),
    onSuccess: async (response) => {
      // Панель с паролем закрывает человек: закрыть её — то же, что потерять пароль.
      setCreated({ id: response.gateway.id, account: response.account });
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <FormDialog
          label="Добавить шлюз"
          title="Новый шлюз"
          description="Пароль SIP кабинет покажет один раз — сразу после добавления."
        >
          <GatewayForm onCreate={(draft) => add.mutateAsync(draft)} />
        </FormDialog>
      </div>

      {created !== undefined && (
        <SipCredentials
          account={created.account}
          title="Доступ для нового шлюза"
          onClose={() => {
            setCreated(undefined);
          }}
        >
          <Link
            href={`/partner/equipment/${created.id}`}
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Открыть шлюз — порты и настройки →
          </Link>
        </SipCredentials>
      )}
    </div>
  );
}

interface GatewayDraft {
  readonly name: string;
  readonly type: 'goip' | 'android';
  readonly model?: string;
  readonly portCount: number;
}

/** Поля окна «Новый шлюз». Порты 1…N появляются вместе со шлюзом. */
function GatewayForm({ onCreate }: { onCreate: (draft: GatewayDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<'goip' | 'android'>('goip');
  const [portCount, setPortCount] = useState('8');

  // У телефона Android слот один — спрашивать нечего.
  const ports = type === 'android' ? 1 : integerFromInput(portCount);
  const portsValid = ports !== undefined && ports >= 1 && ports <= MAX_PORTS;
  const nameValid = name.trim().length >= 2;

  return (
    <DialogForm
      submitLabel="Добавить шлюз"
      canSubmit={nameValid && portsValid}
      onSubmit={async () => {
        if (ports === undefined) return;
        await onCreate({
          name,
          type,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          portCount: ports,
        });
      }}
    >
      <DialogField label="Название" hint="Чтобы отличать шлюзы между собой">
        <Input
          value={name}
          placeholder="GOIP в офисе"
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Вид">
        <select
          value={type}
          onChange={(event) => {
            setType(event.target.value === 'android' ? 'android' : 'goip');
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="goip">GOIP</option>
          <option value="android">Телефон Android</option>
        </select>
      </DialogField>

      <DialogField label="Модель" hint="Необязательно">
        <Input
          value={model}
          placeholder="GoIP-8"
          autoComplete="off"
          onChange={(event) => {
            setModel(event.target.value);
          }}
        />
      </DialogField>

      {type === 'goip' && (
        <DialogField label="Слотов под SIM" hint="Сколько на корпусе — столько и портов">
          <Input
            className="num"
            inputMode="numeric"
            autoComplete="off"
            value={portCount}
            onChange={(event) => {
              setPortCount(event.target.value);
            }}
          />
        </DialogField>
      )}

      {/* Почему кнопка неактивна, говорится прямо: иначе её не отличить от сломанной. */}
      {name !== '' && !nameValid && (
        <p className="text-warn sm:col-span-2">Название — не короче двух знаков.</p>
      )}
      {!portsValid && (
        <p className="text-warn sm:col-span-2">Слотов — целое число от 1 до {String(MAX_PORTS)}.</p>
      )}
    </DialogForm>
  );
}

/** Кнопка называет действие, а не состояние, в которое переводит. */
const GATEWAY_ACTION = {
  active: 'Включить',
  suspended: 'Выключить',
  retired: 'Удалить навсегда',
} as const;

const GATEWAY_ACTION_MEANING = {
  active:
    'Шлюз начнёт регистрироваться на узле и принимать вызовы. Включайте, когда устройство уже настроено.',
  suspended:
    'Шлюз перестанет получать вызовы. Идущие разговоры не рвутся. Включить обратно можно здесь же, в любой момент.',
  retired:
    'Шлюз удаляется навсегда: вернуть его нельзя, только добавить заново. Карты из его портов вынимаются — их можно вставить в другой шлюз.',
} as const;

type GatewayTarget = keyof typeof GATEWAY_ACTION;

/**
 * Состояние шлюза — одна кнопка и окно с вариантами, как у администратора.
 *
 * Показываются только переходы, которые API примет: кто выключил, решает, кто вправе
 * вернуть (ADR-0047). Отключённым площадкой или порогом партнёр не распоряжается вовсе.
 */
export function GatewayStatus({ gateway }: { gateway: Gateway }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (status: GatewayTarget) =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: () => atMost(refresh()),
  });

  const current = gatewayStateName(gateway);

  if (gateway.status === 'suspended' && gateway.suspended_by !== 'partner') {
    return (
      <p className="text-muted-foreground">
        {gateway.suspended_by === 'failure_threshold'
          ? 'Много неудачных вызовов — проверьте оборудование и напишите площадке: включит администратор.'
          : 'Включить или удалить этот шлюз может только администратор площадки.'}
      </p>
    );
  }

  const occupied = gateway.ports.filter((port) => port.sim !== null).length;
  const targets: GatewayTarget[] =
    gateway.status === 'active' ? ['suspended', 'retired'] : ['active', 'retired'];
  const options: StatusOption<GatewayTarget>[] = targets.map((status) => ({
    value: status,
    action: GATEWAY_ACTION[status],
    meaning:
      status === 'retired' && occupied > 0
        ? `${GATEWAY_ACTION_MEANING.retired} Карт в портах сейчас: ${String(occupied)}.`
        : GATEWAY_ACTION_MEANING[status],
    danger: status !== 'active',
  }));

  return (
    <StatusDialog
      subject={`шлюз «${gateway.name}»`}
      current={current}
      options={options}
      onChange={(status) => change.mutateAsync(status)}
    />
  );
}

/** Новый пароль SIP: имя и пароль меняются разом, старые перестают работать. */
export function NewPassword({ gateway }: { gateway: Gateway }) {
  const [account, setAccount] = useState<SipAccount | undefined>(undefined);
  const refresh = useRefresh();
  const reset = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>(`/partner/gateways/${gateway.id}/credentials`, {
        method: 'POST',
      }),
    onSuccess: async (issued) => {
      setAccount(issued.account);
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <ConfirmAction
          label="Выдать новый пароль"
          title={`Новый пароль для «${gateway.name}»`}
          consequence={
            <p>
              Меняются и имя, и пароль. Шлюз потеряет регистрацию и замолчит, пока вы не введёте
              новые данные в его настройках. Идущие разговоры не рвутся.
            </p>
          }
          confirmLabel="Выдать новый пароль"
          onConfirm={() => reset.mutateAsync()}
        />
      </div>
      {account !== undefined && (
        <SipCredentials
          account={account}
          title={`Новый доступ для «${gateway.name}»`}
          onClose={() => {
            setAccount(undefined);
          }}
        />
      )}
    </div>
  );
}

/** Ещё порты — следующими номерами после последнего. */
export function AddPorts({ gateway }: { gateway: Gateway }) {
  const refresh = useRefresh();
  const add = useMutation({
    mutationFn: (count: number) =>
      request<unknown>(`/partner/gateways/${gateway.id}/ports`, {
        method: 'POST',
        body: { count },
      }),
    onSuccess: refresh,
  });

  return (
    <FormDialog label="Добавить порты" title={`Порты шлюза «${gateway.name}»`} variant="outline">
      <PortsForm
        last={gateway.ports.at(-1)?.port_number ?? 0}
        onAdd={(count) => add.mutateAsync(count)}
      />
    </FormDialog>
  );
}

function PortsForm({ last, onAdd }: { last: number; onAdd: (count: number) => Promise<unknown> }) {
  const [value, setValue] = useState('1');
  const count = integerFromInput(value);
  const valid = count !== undefined && count >= 1 && last + count <= MAX_PORTS;

  return (
    <DialogForm
      submitLabel="Добавить"
      canSubmit={valid}
      onSubmit={async () => {
        if (count !== undefined) await onAdd(count);
      }}
    >
      <DialogField
        label="Сколько портов"
        hint={
          valid
            ? `Появятся порты ${String(last + 1)}–${String(last + count)}`
            : `Сейчас последний — ${String(last)}`
        }
      >
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>
      {value !== '' && !valid && (
        <p className="text-warn sm:col-span-2">
          Целое число; всего портов у шлюза — не больше {String(MAX_PORTS)}.
        </p>
      )}
    </DialogForm>
  );
}

/**
 * Вставить карту в порт: новую — по номеру, или одну из вынутых раньше.
 *
 * Одно действие вместо двух: раньше карту заводили отдельным окном, а потом выбирали
 * в порту. Оператора площадка определяет по номеру сама — спрашивать его значило
 * только дать ошибиться.
 */
export function InsertSim({
  portId,
  portNumber,
  spare,
}: {
  portId: string;
  portNumber: number;
  spare: readonly Sim[];
}) {
  const refresh = useRefresh();
  const insert = useMutation({
    mutationFn: async (choice: { msisdn: string } | { simCardId: string }) => {
      const simCardId =
        'simCardId' in choice
          ? choice.simCardId
          : (
              await request<{ sim: { id: string } }>('/partner/sim-cards', {
                method: 'POST',
                body: { msisdn: choice.msisdn },
              })
            ).sim.id;
      await request<unknown>(`/partner/gateway-ports/${portId}/sim`, {
        method: 'POST',
        body: { simCardId },
      });
    },
    // Карта могла добавиться, а вставка — не пройти: экран обновляется в любом случае,
    // и добавленная карта окажется среди вынутых, а не пропадёт.
    onSettled: refresh,
  });

  return (
    <FormDialog label="Вставить SIM" title={`SIM в порт ${String(portNumber)}`} variant="outline">
      <InsertSimForm spare={spare} onInsert={(choice) => insert.mutateAsync(choice)} />
    </FormDialog>
  );
}

function InsertSimForm({
  spare,
  onInsert,
}: {
  spare: readonly Sim[];
  onInsert: (choice: { msisdn: string } | { simCardId: string }) => Promise<unknown>;
}) {
  const [msisdn, setMsisdn] = useState('');
  const [simCardId, setSimCardId] = useState('');
  const typed = msisdn.trim() !== '';

  return (
    <DialogForm
      submitLabel="Вставить"
      canSubmit={typed || simCardId !== ''}
      onSubmit={() => onInsert(typed ? { msisdn } : { simCardId })}
    >
      <DialogField label="Номер карты" wide>
        <Input
          className="num"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={msisdn}
          placeholder="+7 913 042-41-23"
          onChange={(event) => {
            setMsisdn(event.target.value);
            setSimCardId('');
          }}
        />
      </DialogField>

      {spare.length > 0 && (
        <DialogField label="Или карта, вынутая раньше" wide>
          <select
            value={simCardId}
            onChange={(event) => {
              setSimCardId(event.target.value);
              setMsisdn('');
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 num"
          >
            <option value="">—</option>
            {spare.map((sim) => (
              <option key={sim.id} value={sim.id}>
                {sim.msisdn}
                {sim.operator_name === null ? '' : ` · ${sim.operator_name}`}
              </option>
            ))}
          </select>
        </DialogField>
      )}

      <p className="text-muted-foreground sm:col-span-2">
        Оператора площадка определит по номеру сама. Звонки через карту пойдут только внутри её сети
        — там, где у вас безлимит.
      </p>
    </DialogForm>
  );
}

/** Вынуть карту из порта. Карта остаётся — среди вынутых, её можно вставить снова. */
export function RemoveSim({ portId }: { portId: string }) {
  const refresh = useRefresh();
  const remove = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateway-ports/${portId}/sim`, {
        method: 'POST',
        body: { simCardId: null },
      }),
    onSuccess: refresh,
  });
  const error = asApiError(remove.error);

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={remove.isPending}
        onClick={() => {
          remove.mutate();
        }}
      >
        Вынуть
      </Button>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/**
 * Включить или удалить свою карту.
 *
 * Рисуется только то, что API примет. Заблокированную или придержанную площадкой карту
 * партнёр не трогает — это её рычаг; стоящую в порту не удалить, сначала её вынимают.
 */
export function SimActions({ sim, inPort }: { sim: Sim; inPort: boolean }) {
  const refresh = useRefresh();

  const activate = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/sim-cards/${sim.id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: refresh,
  });

  const retire = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/sim-cards/${sim.id}/status`, {
        method: 'POST',
        body: { status: 'retired' },
      }),
    onSuccess: () => atMost(refresh()),
  });

  const error = asApiError(activate.error);
  if (sim.status === 'retired' || sim.status === 'active') return null;
  if (sim.status === 'blocked' || sim.status === 'throttled') {
    return <span className="text-muted-foreground">распоряжается администратор площадки</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={activate.isPending}
          onClick={() => {
            activate.mutate();
          }}
        >
          Включить
        </Button>
        {!inPort && (
          <ConfirmAction
            label="Удалить"
            title={`Удалить карту ${sim.msisdn}`}
            consequence={
              <p>Карта удаляется навсегда. Вернуть её нельзя — только добавить заново.</p>
            }
            confirmLabel="Удалить карту"
            disabled={activate.isPending}
            onConfirm={() => retire.mutateAsync()}
          />
        )}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}
