'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { SipCredentials, type SipAccount } from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { useOperators } from '@/lib/dictionaries';
import { SIM_STATUS_MEANING } from '@/lib/labels';
import { integerFromInput } from '@/lib/money';
import type { Gateway, Sim } from './equipment';

/**
 * Действия партнёра над своим оборудованием
 * ([ADR-0043](../../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
 *
 * Отдельным файлом от страницы: та показывает состояние, этот — меняет его. Смешивать
 * их значит держать в одном файле два разных повода для правки.
 *
 * Все обращения идут в собственный контур `/partner/*`: идентификатор партнёра там
 * выводится из сессии, и подставить чужой нечего.
 *
 * Заведение шлюза и SIM и новый порт — окнами по центру: отказ показывает окно.
 *
 * Необратимое и останавливающее связь — списание и перевыпуск доступа — идёт через
 * `ConfirmAction`. У каждого такого действия своя мутация: отказ показывается в окне
 * подтверждения, и в общей строке ошибок он повторился бы вторым сообщением.
 */

/** Общий хвост любого действия: перечитать оборудование целиком. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['partner', 'equipment'] });
  };
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/** Заведение шлюза. Учётные данные SIP показываются на странице и один раз. */
export function AddGateway() {
  const refresh = useRefresh();
  const [account, setAccount] = useState<SipAccount | undefined>(undefined);

  const add = useMutation({
    mutationFn: (draft: GatewayDraft) =>
      request<{ account: SipAccount }>('/partner/gateways', { method: 'POST', body: { ...draft } }),
    onSuccess: async (created) => {
      // Панель с паролем закрывает человек: закрыть её — то же, что потерять пароль.
      setAccount(created.account);
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <FormDialog
          label="Завести шлюз"
          title="Новый шлюз"
          description="Пароль SIP кабинет покажет один раз — сразу после заведения."
          variant="outline"
        >
          <GatewayForm onCreate={(draft) => add.mutateAsync(draft)} />
        </FormDialog>
      </div>

      {account !== undefined && (
        <SipCredentials
          account={account}
          title="Доступ для этого шлюза"
          onClose={() => {
            setAccount(undefined);
          }}
        />
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

/** Поля окна «Новый шлюз». */
function GatewayForm({ onCreate }: { onCreate: (draft: GatewayDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<'goip' | 'android'>('goip');
  const [portCount, setPortCount] = useState('8');

  const ports = integerFromInput(portCount);
  const portsValid = ports !== undefined && ports <= 256;
  const nameValid = name.trim().length >= 2;

  return (
    <DialogForm
      submitLabel="Завести шлюз"
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
      <DialogField label="Название">
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

      <DialogField label="Модель">
        <Input
          value={model}
          placeholder="GoIP-8"
          autoComplete="off"
          onChange={(event) => {
            setModel(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Портов">
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

      {/* Почему кнопка неактивна, говорится прямо: иначе её не отличить от сломанной. */}
      {name !== '' && !nameValid && (
        <p className="text-warn sm:col-span-2">Название — не короче двух знаков.</p>
      )}
      {!portsValid && <p className="text-warn sm:col-span-2">Число портов — целое, от 0 до 256.</p>}

      <p className="text-muted-foreground sm:col-span-2">
        Шлюз заводится выключенным: пароль SIP выдаётся сразу, но регистрацию на узле он получит
        только после включения. Настройте оборудование, потом включайте.
      </p>
    </DialogForm>
  );
}

/** Включение, выключение, новый порт, перевыпуск доступа и списание — по одному шлюзу. */
export function GatewayActions({ gateway }: { gateway: Gateway }) {
  const refresh = useRefresh();
  const [account, setAccount] = useState<SipAccount | undefined>(undefined);

  const activate = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: refresh,
  });

  // Выключение — через подтверждение: оно останавливает трафик. Включить обратно партнёр
  // может сам — источник выключения записывается (ADR-0047). Отказ показывается в окне.
  const suspend = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status: 'suspended' },
      }),
    onSuccess: () => atMost(refresh()),
  });

  // Окно закрывается, когда обновление пришло: шлюза в списке уже нет, и фокус встаёт
  // рядом, а не падает на страницу (ConfirmAction).
  const retire = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status: 'retired' },
      }),
    onSuccess: () => atMost(refresh()),
  });

  const addPort = useMutation({
    mutationFn: (portNumber: number) =>
      request<unknown>(`/partner/gateways/${gateway.id}/ports`, {
        method: 'POST',
        body: { portNumber },
      }),
    onSuccess: refresh,
  });

  const reset = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>(`/partner/gateways/${gateway.id}/credentials`, {
        method: 'POST',
      }),
    onSuccess: (issued) => {
      setAccount(issued.account);
    },
  });

  // Отказ нового порта показывает его окно, здесь — только отказ включения.
  const error = asApiError(activate.error);
  const nextPort = String((gateway.ports.at(-1)?.port_number ?? 0) + 1);
  // Списание шлюза вынимает карты из его портов: порта после списания не существует.
  // Их число называется до подтверждения, а не после — отменить будет нечем.
  const occupied = gateway.ports.filter((slot) => slot.sim !== null).length;
  // Кто выключил, решает, кто вправе вернуть (ADR-0047): своё выключение партнёр снимает
  // сам, отключение площадкой или порогом — нет, ни включением, ни списанием.
  const lockedByPlatform = gateway.status === 'suspended' && gateway.suspended_by !== 'partner';
  const canActivate =
    gateway.status === 'pending' ||
    (gateway.status === 'suspended' && gateway.suspended_by === 'partner');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        {gateway.status === 'active' && (
          <ConfirmAction
            label="Выключить"
            title={`Выключить шлюз «${gateway.name}»`}
            consequence={
              <p>
                Шлюз перестанет получать вызовы от площадки. Включить его обратно можно здесь же, в
                любой момент.
              </p>
            }
            confirmLabel="Выключить шлюз"
            onConfirm={() => suspend.mutateAsync()}
          />
        )}
        {lockedByPlatform && (
          <span className="self-center text-muted-foreground">
            {gateway.suspended_by === 'failure_threshold'
              ? 'много неудачных вызовов — проверьте оборудование и напишите площадке: включит администратор'
              : 'включить или списать его может только администратор площадки'}
          </span>
        )}
        {canActivate && (
          <Button
            size="sm"
            disabled={activate.isPending}
            onClick={() => {
              activate.mutate();
            }}
          >
            Включить
          </Button>
        )}

        <FormDialog
          label="Добавить порт"
          title={`Новый порт шлюза «${gateway.name}»`}
          variant="outline"
        >
          <PortForm initial={nextPort} onAdd={(portNumber) => addPort.mutateAsync(portNumber)} />
        </FormDialog>

        <ConfirmAction
          label="Перевыпустить доступ"
          title={`Перевыпустить доступ шлюза «${gateway.name}»`}
          consequence={
            <p>
              Имя и пароль SIP меняются сразу. Шлюз потеряет регистрацию и замолчит, пока вы не
              введёте новые данные в его настройках. Идущие разговоры не рвутся.
            </p>
          }
          confirmLabel="Перевыпустить"
          onConfirm={() => reset.mutateAsync()}
        />

        {gateway.status !== 'retired' && !lockedByPlatform && (
          <ConfirmAction
            label="Списать"
            title={`Списать шлюз «${gateway.name}»`}
            consequence={
              <>
                <p>Шлюз выводится навсегда: вернуть его в работу нельзя, только завести новый.</p>
                {occupied > 0 && (
                  <p>
                    Из его портов будут вынуты карты: {occupied}. Их можно поставить в другой шлюз.
                  </p>
                )}
              </>
            }
            confirmLabel={
              occupied === 0 ? 'Списать шлюз' : `Списать и вынуть карт: ${String(occupied)}`
            }
            disabled={activate.isPending}
            onConfirm={() => retire.mutateAsync()}
          />
        )}
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

      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Поле окна «Новый порт»: номер предлагается следующим за последним. */
function PortForm({
  initial,
  onAdd,
}: {
  initial: string;
  onAdd: (portNumber: number) => Promise<unknown>;
}) {
  const [portNumber, setPortNumber] = useState(initial);
  const port = integerFromInput(portNumber);
  const portValid = port !== undefined && port >= 1 && port <= 256;

  return (
    <DialogForm
      submitLabel="Добавить порт"
      canSubmit={portValid}
      onSubmit={async () => {
        if (port !== undefined) await onAdd(port);
      }}
    >
      <DialogField label="Номер порта">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={portNumber}
          onChange={(event) => {
            setPortNumber(event.target.value);
          }}
        />
      </DialogField>
      {portNumber !== '' && !portValid && (
        <p className="text-warn sm:col-span-2">Номер порта — целое число от 1 до 256.</p>
      )}
    </DialogForm>
  );
}

/** Заведение SIM. Оператора сверяет источник — заявление на слово не принимается. */
export function AddSim() {
  const refresh = useRefresh();

  const add = useMutation({
    mutationFn: (input: { msisdn: string; operatorId: string }) =>
      request<unknown>('/partner/sim-cards', { method: 'POST', body: input }),
    onSuccess: refresh,
  });

  return (
    <div>
      <FormDialog label="Завести SIM" title="Новая SIM" variant="outline">
        <SimForm onCreate={(input) => add.mutateAsync(input)} />
      </FormDialog>
    </div>
  );
}

/** Поля окна «Новая SIM». */
function SimForm({
  onCreate,
}: {
  onCreate: (input: { msisdn: string; operatorId: string }) => Promise<unknown>;
}) {
  const operators = useOperators();
  const [msisdn, setMsisdn] = useState('');
  const [operatorId, setOperatorId] = useState('');

  const operatorsError = asApiError(operators.error);
  const ready = msisdn.trim() !== '' && operatorId !== '';

  return (
    <DialogForm
      submitLabel="Завести SIM"
      canSubmit={ready}
      onSubmit={() => onCreate({ msisdn, operatorId })}
    >
      <DialogField label="Номер карты">
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
          }}
        />
      </DialogField>

      {/*
        Пока справочник не пришёл, выбор не открывается: пустой список до ответа
        выглядит так же, как пустой в ответе, и форму было не отправить без объяснения.
      */}
      <DialogField label="Оператор">
        <select
          value={operatorId}
          disabled={!operators.ready}
          onChange={(event) => {
            setOperatorId(event.target.value);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="">
            {operators.ready ? 'выберите оператора' : 'загружаем операторов…'}
          </option>
          {operators.rows.map((operator) => (
            <option key={operator.id} value={operator.id}>
              {operator.name}
            </option>
          ))}
        </select>
      </DialogField>

      {operatorsError !== undefined && (
        <div className="sm:col-span-2">
          <ErrorNote error={operatorsError} />
        </div>
      )}

      <p className="text-muted-foreground sm:col-span-2">
        Оператора площадка проверяет по самому номеру. Если он окажется другим — карта не заведётся:
        у вас безлимит только внутри своей сети, и вызов через чужую сеть уйдёт за ваш счёт.
      </p>
    </DialogForm>
  );
}

/**
 * Что можно сделать со своей картой: включить или списать.
 *
 * Рисуется только то, что API примет. Заблокированную площадкой карту партнёр не трогает —
 * это её рычаг; стоящую в порту не списать, сначала её вынимают. Раньше обе кнопки были
 * на месте и получали отказ уже после подтверждения (разбор правок ui-review, 2026-09-14).
 * Подтверждён ли оператор при включении, решает внешний источник, поэтому «Включить»
 * остаётся, а ответ показывается под кнопкой.
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
  if (sim.status === 'retired') return null;
  if (sim.status === 'blocked') {
    return (
      <span className="text-muted-foreground">
        заблокирована площадкой — распоряжается администратор
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {/* Придержанную карту включает только администратор (ADR-0047): порог отключил
            бы её снова на следующем проходе, пока старые отказы ещё в окне. */}
        {sim.status === 'throttled' && (
          <span className="self-center text-muted-foreground">
            придержана площадкой — включает администратор
          </span>
        )}
        {sim.status !== 'active' && sim.status !== 'throttled' && (
          <Button
            variant="outline"
            size="sm"
            disabled={activate.isPending}
            onClick={() => {
              activate.mutate();
            }}
          >
            Включить
          </Button>
        )}
        {!inPort && sim.status !== 'throttled' && (
          <ConfirmAction
            label="Списать"
            title={`Списать карту ${sim.msisdn}`}
            consequence={<p>{SIM_STATUS_MEANING.retired}</p>}
            confirmLabel="Списать карту"
            disabled={activate.isPending}
            onConfirm={() => retire.mutateAsync()}
          />
        )}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Что стоит в порту: выбор карты из свободных или «вынуть». */
export function PortSim({
  portId,
  spare,
  filled,
}: {
  portId: string;
  spare: readonly Sim[];
  filled: boolean;
}) {
  const refresh = useRefresh();
  const assign = useMutation({
    mutationFn: (simCardId: string | null) =>
      request<unknown>(`/partner/gateway-ports/${portId}/sim`, {
        method: 'POST',
        body: { simCardId },
      }),
    onSuccess: refresh,
  });

  const error = asApiError(assign.error);

  return (
    <div className="flex flex-col gap-1">
      {filled ? (
        <Button
          variant="outline"
          size="sm"
          disabled={assign.isPending}
          onClick={() => {
            assign.mutate(null);
          }}
        >
          Вынуть
        </Button>
      ) : (
        <select
          value=""
          disabled={assign.isPending || spare.length === 0}
          onChange={(event) => {
            if (event.target.value !== '') assign.mutate(event.target.value);
          }}
          className="h-8 w-[180px] rounded-md border border-input bg-transparent px-2"
        >
          <option value="">{spare.length === 0 ? 'свободных карт нет' : 'вставить карту'}</option>
          {spare.map((sim) => (
            <option key={sim.id} value={sim.id}>
              {sim.msisdn}
            </option>
          ))}
        </select>
      )}
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}
