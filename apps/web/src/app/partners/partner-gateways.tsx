'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  REGISTRABLE_GATEWAY_STATUSES,
  type GatewayPortState,
  type GatewayStatus,
  type GatewayType,
  type SimStatus,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { SipCredentials, type SipAccount } from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import {
  GATEWAY_STATUS_MEANING,
  GATEWAY_STATUS_NAME,
  GATEWAY_TYPE_NAME,
  PORT_STATE_NAME,
  usableTone,
} from '@/lib/labels';
import { integerFromInput } from '@/lib/money';

interface Gateway {
  readonly id: string;
  readonly name: string;
  readonly type: GatewayType;
  readonly status: GatewayStatus;
  readonly sip_username: string;
  readonly registered_at: string | null;
  readonly model: string | null;
  readonly port_count: number;
}

interface Port {
  readonly id: string;
  readonly port_number: number;
  readonly sim_card_id: string | null;
  readonly state: GatewayPortState;
}

export interface SimOption {
  readonly id: string;
  readonly msisdn: string;
  readonly status: SimStatus;
}

const COLUMNS = 7;

/** Границы из API: портов у шлюза от нуля, номер порта от единицы, не больше 256. */
const MAX_PORTS = 256;

/**
 * Кнопка смены состояния называет **действие**, а не состояние: «Приостановлен» рядом
 * с плашкой текущего состояния читалось как ещё одна плашка, а не как кнопка.
 */
const STATUS_ACTION: Record<GatewayStatus, string> = {
  pending: 'Вернуть в «ждёт»',
  active: 'Включить',
  suspended: 'Приостановить',
  retired: 'Вывести навсегда',
};

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Шлюзы партнёра: заведение, доступ SIP, состояние, порты.
 *
 * Шлюз заводится `pending`: учётная запись выдана, но каталог её не отдаёт, пока
 * администратор не переведёт шлюз в «работает». То есть выдача доступа и допуск
 * к трафику — два отдельных решения, и это намеренно.
 *
 * Включение — одним нажатием. Всё, что останавливает трафик или необратимо
 * (приостановка, возврат в «ждёт», вывод, перевыпуск доступа), — через подтверждение
 * с названным последствием: раньше вывод шлюза вместе с вынутыми SIM срабатывал
 * с первого нажатия (ui-review, 2026-09-14).
 */
export function PartnerGateways({ partnerId, sims }: { partnerId: string; sims: SimOption[] }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<{ title: string; account: SipAccount } | undefined>(
    undefined,
  );
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [type, setType] = useState<GatewayType>('goip');
  const [model, setModel] = useState('');
  const [portCount, setPortCount] = useState('8');

  const list = useQuery({
    queryKey: ['gateways', partnerId],
    queryFn: () => request<{ gateways: Gateway[] }>(`/gateways?partnerId=${partnerId}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['gateways', partnerId] });
  };

  const create = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>('/gateways', {
        method: 'POST',
        body: {
          partnerId,
          name,
          type,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          portCount: integerFromInput(portCount),
        },
      }),
    onSuccess: async (data) => {
      setCreating(false);
      setName('');
      setModel('');
      setIssued({ title: `Доступ SIP для шлюза «${name}»`, account: data.account });
      await invalidate();
    },
  });

  const activate = useMutation({
    mutationFn: (gateway: Gateway) =>
      request<unknown>(`/gateways/${gateway.id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемые действия — своими мутациями: их отказ показывается в окне
  // подтверждения и не должен повторяться в общей строке ошибок.
  const confirmStatus = useMutation({
    mutationFn: (input: { gateway: Gateway; status: GatewayStatus }) =>
      request<unknown>(`/gateways/${input.gateway.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => {
      void invalidate();
    },
  });

  const reissue = useMutation({
    mutationFn: (gateway: Gateway) =>
      request<{ account: SipAccount }>(`/gateways/${gateway.id}/credentials`, { method: 'POST' }),
    onSuccess: (data, gateway) => {
      setIssued({ title: `Новый доступ SIP для шлюза «${gateway.name}»`, account: data.account });
      void invalidate();
    },
  });

  const failed = asApiError(create.error ?? activate.error ?? list.error);
  const ports = integerFromInput(portCount);
  const portsValid = ports !== undefined && ports <= MAX_PORTS;
  const nameValid = name.trim().length >= 2;
  const busy = activate.isPending || confirmStatus.isPending || reissue.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Шлюзы</h3>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating(!creating);
            }}
          >
            {creating ? 'Отменить' : 'Завести шлюз'}
          </Button>
        )}
      </div>

      {issued !== undefined && (
        <SipCredentials
          account={issued.account}
          title={issued.title}
          onClose={() => {
            setIssued(undefined);
          }}
        />
      )}

      {canChange && creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid && portsValid) create.mutate();
          }}
          className="flex max-w-[900px] flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Название</span>
            <Input
              className="w-[200px]"
              value={name}
              autoComplete="off"
              placeholder="GOIP в Казани"
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
                setType(event.target.value as GatewayType);
              }}
              className="h-9 rounded-md border border-input bg-transparent px-2"
            >
              {GATEWAY_TYPES.map((kind) => (
                <option key={kind} value={kind}>
                  {GATEWAY_TYPE_NAME[kind]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Модель</span>
            <Input
              className="w-[160px]"
              value={model}
              autoComplete="off"
              placeholder="необязательно"
              onChange={(event) => {
                setModel(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Портов</span>
            <Input
              className="num w-[80px]"
              inputMode="numeric"
              autoComplete="off"
              value={portCount}
              onChange={(event) => {
                setPortCount(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!nameValid || !portsValid || create.isPending}>
            {create.isPending ? 'Заводим…' : 'Завести'}
          </Button>

          {name !== '' && !nameValid && (
            <p className="w-full text-warn">Название — не короче двух знаков.</p>
          )}
          {!portsValid && (
            <p className="w-full text-warn">Число портов — целое, от 0 до {MAX_PORTS}.</p>
          )}

          <p className="w-full text-muted-foreground">
            {/*
              Запись типа `android` не может писать разговор (ADR-0012), и канал
              с требованием записи на неё не маршрутизируется. Сказать это здесь дешевле,
              чем разбирать потом «почему клиент не звонит через этот шлюз».
            */}
            Шлюз заведётся в состоянии «ждёт»: доступ SIP выдан, но регистрация не пройдёт, пока вы
            не переведёте его в «работает». Через шлюз вида «Android» не пойдут каналы с
            обязательной записью — там она технически невозможна.
          </p>
        </form>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="max-w-[900px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Шлюз</TableHead>
              <TableHead className="h-8">Вид</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Имя SIP</TableHead>
              <TableHead className="h-8 text-right">Портов</TableHead>
              <TableHead className="h-8">Регистрация</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.gateways.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Шлюзов нет — звонить партнёру не через что.
                </TableCell>
              </TableRow>
            )}

            {list.data?.gateways.map((gateway) => (
              <GatewayRows
                key={gateway.id}
                gateway={gateway}
                sims={sims}
                open={opened === gateway.id}
                busy={busy}
                onToggle={() => {
                  setOpened(opened === gateway.id ? undefined : gateway.id);
                }}
                onActivate={() => {
                  activate.mutate(gateway);
                }}
                onConfirmStatus={(status) => confirmStatus.mutateAsync({ gateway, status })}
                onReissue={() => reissue.mutateAsync(gateway)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GatewayRows({
  gateway,
  sims,
  open,
  busy,
  onToggle,
  onActivate,
  onConfirmStatus,
  onReissue,
}: {
  gateway: Gateway;
  sims: SimOption[];
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onConfirmStatus: (status: GatewayStatus) => Promise<unknown>;
  onReissue: () => Promise<unknown>;
}) {
  const canChange = useCanChange();

  return (
    <>
      <TableRow>
        <TableCell>
          {gateway.name}
          {gateway.model !== null && <span className="block text-faint">{gateway.model}</span>}
        </TableCell>
        <TableCell>{GATEWAY_TYPE_NAME[gateway.type]}</TableCell>
        <TableCell>
          <span
            className={`rounded-sm px-1.5 py-0.5 ${usableTone(
              REGISTRABLE_GATEWAY_STATUSES.includes(gateway.status),
            )}`}
          >
            {GATEWAY_STATUS_NAME[gateway.status]}
          </span>
        </TableCell>
        <TableCell>
          <span className="num" translate="no">
            {gateway.sip_username}
          </span>
        </TableCell>
        <TableCell className="num text-right">{gateway.port_count}</TableCell>
        <TableCell>
          {gateway.registered_at === null ? (
            <span className="text-warn">не регистрировался</span>
          ) : (
            <span className="num text-muted-foreground">{moment(gateway.registered_at)}</span>
          )}
        </TableCell>
        <TableCell>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'Свернуть' : 'Порты'}
          </Button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <div className="flex flex-col gap-3">
              {canChange && gateway.status === 'retired' && (
                <p className="text-muted-foreground">
                  Шлюз выведен навсегда: состояние больше не меняется, SIM из его портов вынуты.
                </p>
              )}

              {canChange && gateway.status !== 'retired' && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Состояние шлюза:</span>
                  {GATEWAY_STATUSES.filter((status) => status !== gateway.status).map((status) =>
                    status === 'active' ? (
                      <Button
                        key={status}
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={onActivate}
                      >
                        {STATUS_ACTION[status]}
                      </Button>
                    ) : (
                      <ConfirmAction
                        key={status}
                        label={STATUS_ACTION[status]}
                        title={`${STATUS_ACTION[status]}: шлюз «${gateway.name}»`}
                        consequence={<p>{GATEWAY_STATUS_MEANING[status]}</p>}
                        confirmLabel={STATUS_ACTION[status]}
                        disabled={busy}
                        onConfirm={() => onConfirmStatus(status)}
                      />
                    ),
                  )}
                  <ConfirmAction
                    className="ml-auto"
                    label="Перевыпустить доступ"
                    title={`Перевыпустить доступ шлюза «${gateway.name}»`}
                    consequence={
                      <p>
                        Имя и пароль SIP меняются сразу. Шлюз потеряет регистрацию и замолчит, пока
                        партнёр не введёт новые данные в настройках оборудования. Идущие разговоры
                        не рвутся.
                      </p>
                    }
                    confirmLabel="Перевыпустить"
                    disabled={busy}
                    onConfirm={onReissue}
                  />
                </div>
              )}

              <GatewayPorts gatewayId={gateway.id} sims={sims} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Порты шлюза и установленные в них SIM.
 *
 * Спрашиваются только у раскрытого шлюза: у каждого свой список, и запрос на шлюз
 * превратил бы открытие карточки партнёра в десяток обращений.
 */
function GatewayPorts({ gatewayId, sims }: { gatewayId: string; sims: SimOption[] }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [portNumber, setPortNumber] = useState('');

  const list = useQuery({
    queryKey: ['ports', gatewayId],
    queryFn: () => request<{ ports: Port[] }>(`/gateways/${gatewayId}/ports`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['ports', gatewayId] });
  };

  const addPort = useMutation({
    mutationFn: () =>
      request<unknown>(`/gateways/${gatewayId}/ports`, {
        method: 'POST',
        body: { portNumber: integerFromInput(portNumber) },
      }),
    onSuccess: async () => {
      setPortNumber('');
      await invalidate();
    },
  });

  const assign = useMutation({
    mutationFn: (input: { portId: string; simCardId: string | null }) =>
      request<unknown>(`/gateway-ports/${input.portId}/sim`, {
        method: 'POST',
        body: { simCardId: input.simCardId },
      }),
    onSuccess: invalidate,
  });

  const failed = asApiError(list.error ?? addPort.error ?? assign.error);
  const ports = list.data?.ports ?? [];
  const port = integerFromInput(portNumber);
  const portValid = port !== undefined && port >= 1 && port <= MAX_PORTS;

  return (
    <div className="flex flex-col gap-2">
      {canChange && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер порта</span>
            <Input
              className="num w-[100px]"
              inputMode="numeric"
              autoComplete="off"
              value={portNumber}
              placeholder="как на корпусе"
              onChange={(event) => {
                setPortNumber(event.target.value);
              }}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!portValid || addPort.isPending}
            onClick={() => {
              addPort.mutate();
            }}
          >
            Добавить порт
          </Button>
          {portNumber !== '' && !portValid && (
            <p className="w-full text-warn">Номер порта — целое число от 1 до {MAX_PORTS}.</p>
          )}
        </div>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="max-w-[600px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8 text-right">Порт</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">SIM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data !== undefined && ports.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="text-muted-foreground">
                  Портов не объявлено — SIM некуда поставить, и шлюз в отбор не попадёт.
                </TableCell>
              </TableRow>
            )}

            {ports.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="num text-right">{row.port_number}</TableCell>
                <TableCell className="text-muted-foreground">
                  {PORT_STATE_NAME[row.state]}
                </TableCell>
                <TableCell>
                  {canChange ? (
                    <select
                      aria-label={`SIM в порту ${String(row.port_number)}`}
                      value={row.sim_card_id ?? ''}
                      disabled={assign.isPending}
                      onChange={(event) => {
                        assign.mutate({
                          portId: row.id,
                          simCardId: event.target.value === '' ? null : event.target.value,
                        });
                      }}
                      className="h-8 w-[220px] rounded-md border border-input bg-transparent px-2"
                    >
                      <option value="">порт пуст</option>
                      {sims.map((sim) => (
                        <option key={sim.id} value={sim.id}>
                          {sim.msisdn}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="num">
                      {sims.find((sim) => sim.id === row.sim_card_id)?.msisdn ?? (
                        <span className="text-muted-foreground">порт пуст</span>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
