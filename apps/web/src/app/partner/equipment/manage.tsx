'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { SipCredentials, type SipAccount } from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
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

/**
 * Кнопка необратимого действия: первый нажим спрашивает, второй делает.
 *
 * Списание не отменить, а стоит оно рядом с «выключить», которое отменяется одним
 * нажатием. Разница должна быть видна пальцу, а не только глазу.
 */
function Irreversible({
  label,
  confirm,
  disabled,
  onConfirm,
}: {
  label: string;
  confirm: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [asked, setAsked] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      className={asked ? 'text-crit' : ''}
      onClick={() => {
        if (asked) {
          onConfirm();
          setAsked(false);
        } else {
          setAsked(true);
        }
      }}
    >
      {asked ? confirm : label}
    </Button>
  );
}

/** Заведение шлюза. Учётные данные SIP показываются здесь же и один раз. */
export function AddGateway() {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<'goip' | 'android'>('goip');
  const [portCount, setPortCount] = useState('8');
  const [account, setAccount] = useState<SipAccount | undefined>(undefined);

  const add = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>('/partner/gateways', {
        method: 'POST',
        body: {
          name,
          type,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          portCount: Number(portCount),
        },
      }),
    onSuccess: async (created) => {
      // Панель с паролем закрывает человек: закрыть её — то же, что потерять пароль.
      setAccount(created.account);
      setOpen(false);
      setName('');
      setModel('');
      await refresh();
    },
  });

  const error = asApiError(add.error);
  const ready = name.trim().length >= 2 && Number.isInteger(Number(portCount));

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Отменить' : 'Завести шлюз'}
        </Button>
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

      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) add.mutate();
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Название</span>
            <Input
              className="w-[220px]"
              value={name}
              placeholder="GOIP в офисе"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Вид</span>
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value === 'android' ? 'android' : 'goip');
              }}
              className="h-9 w-[160px] rounded-md border border-input bg-transparent px-2"
            >
              <option value="goip">GOIP</option>
              <option value="android">Телефон Android</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Модель</span>
            <Input
              className="w-[180px]"
              value={model}
              placeholder="GoIP-8"
              onChange={(event) => {
                setModel(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Портов</span>
            <Input
              className="num w-[90px]"
              value={portCount}
              onChange={(event) => {
                setPortCount(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || add.isPending}>
            Завести
          </Button>

          <p className="w-full text-muted-foreground">
            Шлюз заводится выключенным: пароль SIP выдаётся сразу, но регистрацию на узле он получит
            только после включения. Настройте оборудование, потом включайте.
          </p>
        </form>
      )}

      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Включение, выключение, новый порт и перевыпуск доступа — по одному шлюзу. */
export function GatewayActions({ gateway }: { gateway: Gateway }) {
  const refresh = useRefresh();
  const [portNumber, setPortNumber] = useState('');
  const [account, setAccount] = useState<SipAccount | undefined>(undefined);

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'suspended' | 'retired') =>
      request<unknown>(`/partner/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: refresh,
  });

  const addPort = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateways/${gateway.id}/ports`, {
        method: 'POST',
        body: { portNumber: Number(portNumber) },
      }),
    onSuccess: async () => {
      setPortNumber('');
      await refresh();
    },
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

  const error = asApiError(setStatus.error ?? addPort.error ?? reset.error);
  const nextPort = String((gateway.ports.at(-1)?.port_number ?? 0) + 1);
  // Списание шлюза вынимает карты из его портов: порта после списания не существует.
  // Их число называется до нажатия, а не после — отменить будет нечем.
  const occupied = gateway.ports.filter((port) => port.sim !== null).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        {gateway.status === 'active' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={setStatus.isPending}
            onClick={() => {
              setStatus.mutate('suspended');
            }}
          >
            Выключить
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={setStatus.isPending || gateway.status === 'retired'}
            onClick={() => {
              setStatus.mutate('active');
            }}
          >
            Включить
          </Button>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (Number.isInteger(Number(portNumber)) && portNumber !== '') addPort.mutate();
          }}
          className="flex items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Новый порт</span>
            <Input
              className="num w-[90px]"
              value={portNumber}
              placeholder={nextPort}
              onChange={(event) => {
                setPortNumber(event.target.value);
              }}
            />
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={addPort.isPending}>
            Добавить
          </Button>
        </form>

        <Button
          variant="outline"
          size="sm"
          disabled={reset.isPending}
          onClick={() => {
            reset.mutate();
          }}
        >
          Перевыпустить доступ
        </Button>

        {gateway.status !== 'retired' && (
          <Irreversible
            label="Списать"
            confirm={
              occupied === 0 ? 'Точно списать?' : `Списать и вынуть карт: ${String(occupied)}?`
            }
            disabled={setStatus.isPending}
            onConfirm={() => {
              setStatus.mutate('retired');
            }}
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

/** Заведение SIM. Оператора сверяет источник — заявление на слово не принимается. */
export function AddSim() {
  const refresh = useRefresh();
  const operators = useOperators();
  const [open, setOpen] = useState(false);
  const [msisdn, setMsisdn] = useState('');
  const [operatorId, setOperatorId] = useState('');

  const add = useMutation({
    mutationFn: () =>
      request<unknown>('/partner/sim-cards', {
        method: 'POST',
        body: { msisdn, operatorId },
      }),
    onSuccess: async () => {
      setOpen(false);
      setMsisdn('');
      await refresh();
    },
  });

  const error = asApiError(add.error);
  const ready = msisdn.trim() !== '' && operatorId !== '';

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Отменить' : 'Завести SIM'}
        </Button>
      </div>

      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) add.mutate();
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер карты</span>
            <Input
              className="num w-[200px]"
              value={msisdn}
              placeholder="+7 913 042-41-23"
              onChange={(event) => {
                setMsisdn(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Оператор</span>
            <select
              value={operatorId}
              onChange={(event) => {
                setOperatorId(event.target.value);
              }}
              className="h-9 w-[220px] rounded-md border border-input bg-transparent px-2"
            >
              <option value="">выберите оператора</option>
              {operators.rows.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.name}
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" size="sm" disabled={!ready || add.isPending}>
            Завести
          </Button>

          <p className="w-full max-w-prose text-muted-foreground">
            Оператора площадка проверяет по самому номеру. Если он окажется другим — карта не
            заведётся: у вас безлимит только внутри своей сети, и вызов через чужую сеть уйдёт за
            ваш счёт.
          </p>
        </form>
      )}

      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/**
 * Что можно сделать со своей картой: включить или списать.
 *
 * Включение проходит только с подтверждённым оператором, списание — только у карты
 * вне порта. Обе проверки на стороне API; здесь показывается их ответ, а не своя
 * догадка о том, пройдёт ли действие.
 */
export function SimActions({ sim }: { sim: Sim }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (status: 'active' | 'retired') =>
      request<unknown>(`/partner/sim-cards/${sim.id}/status`, { method: 'POST', body: { status } }),
    onSuccess: refresh,
  });

  const error = asApiError(change.error);
  if (sim.status === 'retired') return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {sim.status !== 'active' && (
          <Button
            variant="outline"
            size="sm"
            disabled={change.isPending}
            onClick={() => {
              change.mutate('active');
            }}
          >
            Включить
          </Button>
        )}
        <Irreversible
          label="Списать"
          confirm="Точно списать?"
          disabled={change.isPending}
          onConfirm={() => {
            change.mutate('retired');
          }}
        />
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
