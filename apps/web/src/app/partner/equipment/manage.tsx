'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import {
  LineCredentials,
  SipCredentials,
  type IssuedLines,
  type PortAccount,
  type SipAccount,
} from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { integerFromInput } from '@/lib/money';
import { REGISTRATION_MODE_NAME } from '@/lib/labels';
import { EQUIPMENT_KEY, gatewayStateName, type Gateway, type Port, type Sim } from './equipment';

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
 *
 * При входе по линиям паролей столько, сколько линий, и показывается таблица входов:
 * вход самого шлюза в этом режиме не действует, и показывать его значило бы
 * предложить ввести то, что работать не будет (ADR-0054).
 */
export function AddGateway() {
  const refresh = useRefresh();
  const [created, setCreated] = useState<
    { id: string; name: string; account: SipAccount; lines: readonly PortAccount[] } | undefined
  >(undefined);

  const add = useMutation({
    mutationFn: (draft: GatewayDraft) =>
      request<{ gateway: { id: string }; account: SipAccount; port_accounts: PortAccount[] }>(
        '/partner/gateways',
        { method: 'POST', body: { ...draft } },
      ),
    onSuccess: async (response, draft) => {
      // Панель с паролем закрывает человек: закрыть её — то же, что потерять пароль.
      setCreated({
        id: response.gateway.id,
        name: draft.name,
        account: response.account,
        lines: response.port_accounts,
      });
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

      {created !== undefined && created.lines.length > 0 && (
        <>
          <LineCredentials
            lines={created.lines}
            title={`Входы линий шлюза «${created.name}»`}
            onClose={() => {
              setCreated(undefined);
            }}
          />
          <GatewayLink id={created.id} />
        </>
      )}
      {created !== undefined && created.lines.length === 0 && (
        <SipCredentials
          account={created.account}
          title="Доступ для нового шлюза"
          onClose={() => {
            setCreated(undefined);
          }}
        >
          <GatewayLink id={created.id} />
        </SipCredentials>
      )}
    </div>
  );
}

function GatewayLink({ id }: { id: string }) {
  return (
    <Link
      href={`/partner/equipment/${id}`}
      className="self-start font-semibold text-primary underline-offset-4 hover:underline"
    >
      Открыть шлюз — порты и настройки →
    </Link>
  );
}

interface GatewayDraft {
  readonly name: string;
  readonly type: 'goip' | 'android';
  readonly model?: string;
  readonly portCount: number;
  readonly registrationMode: 'gateway' | 'port';
}

/** Поля окна «Новый шлюз». Порты 1…N появляются вместе со шлюзом. */
function GatewayForm({ onCreate }: { onCreate: (draft: GatewayDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<'goip' | 'android'>('goip');
  const [portCount, setPortCount] = useState('8');
  // Предлагается вход по линиям: линию выбирает учётная запись, а не толкование
  // префикса устройством, и видно, какая линия на связи (ADR-0054, решение владельца).
  const [mode, setMode] = useState<'gateway' | 'port'>('port');

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
          registrationMode: type === 'goip' ? mode : 'gateway',
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
        <DialogField
          label="Подключение"
          hint={
            mode === 'port'
              ? 'В GOIP: Config Mode — Config by Line. Можно настроить только одну линию'
              : 'В GOIP: Config Mode — Single Server. Линию выбирает префикс номера'
          }
        >
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value === 'gateway' ? 'gateway' : 'port');
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value="port">Каждая линия отдельно</option>
            <option value="gateway">Весь шлюз одним входом</option>
          </select>
        </DialogField>
      )}

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

/**
 * Состояние шлюза — меткой, и рядом прямая кнопка того, что нужно сейчас.
 *
 * Раньше была одна кнопка «Состояние» и окно с вариантами: по ней не видно, что
 * произойдёт, и главное действие — «Включить» — пряталось внутри. Партнёр настроил GOIP,
 * а шлюз так и остался невключённым, и линии не могли подключиться (владелец,
 * 2026-09-25). Включение — одним нажатием: оно ничего не ломает. Выключение останавливает
 * вызовы, удаление необратимо — оба с подтверждением, названным последствием.
 *
 * Показываются только переходы, которые API примет: кто выключил, решает, кто вправе
 * вернуть (ADR-0047). Отключённым площадкой или порогом партнёр не распоряжается вовсе.
 */
export function GatewayStatus({ gateway }: { gateway: Gateway }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (status: 'active' | 'suspended' | 'retired') =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: () => atMost(refresh()),
  });
  const error = asApiError(change.error);

  const badge = (
    <span
      className={`rounded-sm px-1.5 py-0.5 ${gateway.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
    >
      {gatewayStateName(gateway)}
    </span>
  );

  if (gateway.status === 'suspended' && gateway.suspended_by !== 'partner') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {badge}
        <span className="text-muted-foreground">
          {gateway.suspended_by === 'failure_threshold'
            ? 'Много неудачных вызовов — проверьте оборудование и напишите площадке: включит администратор.'
            : 'Включить или удалить этот шлюз может только администратор площадки.'}
        </span>
      </div>
    );
  }

  const occupied = gateway.ports.filter((port) => port.sim !== null).length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {badge}
        {gateway.status === 'active' ? (
          <ConfirmAction
            label="Выключить шлюз"
            title={`Выключить шлюз «${gateway.name}»`}
            consequence={
              <p>
                Шлюз перестанет получать вызовы, линии отключатся от площадки. Идущие разговоры не
                рвутся. Включить обратно можно здесь же, в любой момент.
              </p>
            }
            confirmLabel="Выключить шлюз"
            onConfirm={() => change.mutateAsync('suspended')}
          />
        ) : (
          <Button
            size="sm"
            disabled={change.isPending}
            onClick={() => {
              change.mutate('active');
            }}
          >
            Включить шлюз
          </Button>
        )}
        <ConfirmAction
          label="Удалить шлюз"
          title={`Удалить шлюз «${gateway.name}»`}
          consequence={
            <p>
              Шлюз удаляется навсегда: вернуть его нельзя, только добавить заново. Карты из его
              портов вынимаются — их можно вставить в другой шлюз.
              {occupied > 0 && ` Карт в портах сейчас: ${String(occupied)}.`}
            </p>
          }
          confirmLabel="Удалить навсегда"
          variant="ghost"
          onConfirm={() => change.mutateAsync('retired')}
        />
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
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

/** Что показать партнёру о переходе на каждый из способов подключения. */
const MODE_SWITCH = {
  port: {
    action: 'Перейти на вход по линиям',
    consequence:
      'У каждой линии появится свой логин и пароль — их покажут один раз, сразу после перехода. В GOIP выберите Config Mode — Config by Line и введите их в Line 1, Line 2 и так далее. Пока линии не введены, вызовы через шлюз не идут; общий вход шлюза перестаёт действовать сразу.',
  },
  gateway: {
    action: 'Перейти на один вход для шлюза',
    consequence:
      'Линии перестанут регистрироваться своими входами — действовать будет общий вход шлюза. В GOIP выберите Config Mode — Single Server и введите префиксы линий из таблицы портов. Пароль общего входа, если он потерян, выдайте заново.',
  },
} as const;

/**
 * Способ подключения шлюза (ADR-0054). Режим у GOIP один на всё устройство, поэтому
 * и здесь он один на шлюз. Переключение — с подтверждением: оно останавливает вызовы,
 * пока устройство не перенастроено.
 */
export function RegistrationMode({
  gateway,
  onIssued,
}: {
  gateway: Gateway;
  onIssued: (issued: IssuedLines) => void;
}) {
  const refresh = useRefresh();
  const target = gateway.registration_mode === 'port' ? 'gateway' : 'port';
  const change = useMutation({
    mutationFn: () =>
      request<{ port_accounts: PortAccount[] }>(
        `/partner/gateways/${gateway.id}/registration-mode`,
        { method: 'POST', body: { mode: target } },
      ),
    onSuccess: async (response) => {
      if (response.port_accounts.length > 0) {
        onIssued({ title: `Входы линий шлюза «${gateway.name}»`, lines: response.port_accounts });
      }
      await refresh();
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>
        <span className="text-muted-foreground">Способ подключения: </span>
        {REGISTRATION_MODE_NAME[gateway.registration_mode]}
      </span>
      <ConfirmAction
        label={MODE_SWITCH[target].action}
        title={`${MODE_SWITCH[target].action}: «${gateway.name}»`}
        consequence={<p>{MODE_SWITCH[target].consequence}</p>}
        confirmLabel={MODE_SWITCH[target].action}
        onConfirm={() => change.mutateAsync()}
      />
    </div>
  );
}

/** Входы линиям, у которых их нет, — после «Добавить порты». */
export function IssueMissingLines({
  gateway,
  onIssued,
}: {
  gateway: Gateway;
  onIssued: (issued: IssuedLines) => void;
}) {
  const refresh = useRefresh();
  const missing = gateway.ports.filter((port) => port.sip_username === null).length;
  const issue = useMutation({
    mutationFn: () =>
      request<{ port_accounts: PortAccount[] }>(
        `/partner/gateways/${gateway.id}/port-credentials`,
        { method: 'POST' },
      ),
    onSuccess: async (response) => {
      if (response.port_accounts.length > 0) {
        onIssued({ title: `Входы линий шлюза «${gateway.name}»`, lines: response.port_accounts });
      }
      await refresh();
    },
  });
  const error = asApiError(issue.error);

  if (missing === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          size="sm"
          disabled={issue.isPending}
          onClick={() => {
            issue.mutate();
          }}
        >
          Выдать входы линиям без входа: {missing}
        </Button>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Новый пароль одной линии: меняются логин и пароль, прежние перестают работать. */
export function NewLineAccount({
  gateway,
  port,
  onIssued,
}: {
  gateway: Gateway;
  port: Port;
  onIssued: (issued: IssuedLines) => void;
}) {
  const refresh = useRefresh();
  const reset = useMutation({
    mutationFn: () =>
      request<{ port_account: PortAccount }>(`/partner/gateway-ports/${port.id}/credentials`, {
        method: 'POST',
      }),
    onSuccess: async (response) => {
      onIssued({
        title: `Новый вход линии ${String(port.port_number)} шлюза «${gateway.name}»`,
        lines: [response.port_account],
      });
      await refresh();
    },
  });

  return (
    <ConfirmAction
      label="Новый пароль"
      title={`Новый вход линии ${String(port.port_number)}`}
      consequence={
        <p>
          Меняются логин и пароль линии. Она замолчит, пока вы не введёте новые данные в Line{' '}
          {port.port_number} в GOIP. Остальные линии и идущие разговоры это не затрагивает.
        </p>
      }
      confirmLabel="Выдать новый пароль"
      size="xs"
      variant="ghost"
      className="h-5 px-1 text-primary"
      onConfirm={() => reset.mutateAsync()}
    />
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
