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
import { GATEWAY_STATUS_NAME, GATEWAY_TYPE_NAME, PORT_STATE_NAME, usableTone } from '@/lib/labels';

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

/**
 * Шлюзы партнёра: заведение, доступ SIP, состояние, порты.
 *
 * Шлюз заводится `pending`: учётная запись выдана, но каталог её не отдаёт, пока
 * администратор не переведёт шлюз в «работает». То есть выдача доступа и допуск
 * к трафику — два отдельных решения, и это намеренно.
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

  const create = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>('/gateways', {
        method: 'POST',
        body: {
          partnerId,
          name,
          type,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          portCount,
        },
      }),
    onSuccess: async (data) => {
      setCreating(false);
      setName('');
      setModel('');
      setIssued({ title: `Доступ SIP для шлюза «${name}»`, account: data.account });
      await queryClient.invalidateQueries({ queryKey: ['gateways', partnerId] });
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: GatewayStatus }) =>
      request<unknown>(`/gateways/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateways', partnerId] });
    },
  });

  const reissue = useMutation({
    mutationFn: (gateway: Gateway) =>
      request<{ account: SipAccount }>(`/gateways/${gateway.id}/credentials`, { method: 'POST' }),
    onSuccess: async (data, gateway) => {
      setIssued({ title: `Новый доступ SIP для шлюза «${gateway.name}»`, account: data.account });
      await queryClient.invalidateQueries({ queryKey: ['gateways', partnerId] });
    },
  });

  const failed = [create.error, changeStatus.error, reissue.error, list.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );

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
            if (name.trim().length >= 2) create.mutate();
          }}
          className="flex max-w-[900px] flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Название</span>
            <Input
              className="w-[200px]"
              value={name}
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
              value={portCount}
              onChange={(event) => {
                setPortCount(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={create.isPending}>
            Завести
          </Button>

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

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <div className="max-w-[900px] rounded-md border border-border bg-card">
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
                busy={changeStatus.isPending || reissue.isPending}
                onToggle={() => {
                  setOpened(opened === gateway.id ? undefined : gateway.id);
                }}
                onStatus={(status) => {
                  changeStatus.mutate({ id: gateway.id, status });
                }}
                onReissue={() => {
                  reissue.mutate(gateway);
                }}
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
  onStatus,
  onReissue,
}: {
  gateway: Gateway;
  sims: SimOption[];
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onStatus: (status: GatewayStatus) => void;
  onReissue: () => void;
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
          <span className="num">{gateway.sip_username}</span>
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
              {canChange && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Состояние шлюза:</span>
                    {GATEWAY_STATUSES.filter((status) => status !== gateway.status).map(
                      (status) => (
                        <Button
                          key={status}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            onStatus(status);
                          }}
                        >
                          {GATEWAY_STATUS_NAME[status]}
                        </Button>
                      ),
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      disabled={busy}
                      onClick={onReissue}
                    >
                      Перевыпустить доступ
                    </Button>
                  </div>

                  <p className="text-muted-foreground">
                    Отключение действует немедленно: каталог перестаёт отдавать учётную запись, и
                    следующая регистрация не пройдёт. Уже идущие разговоры не рвутся. Перевыпуск
                    меняет и имя, и пароль — шлюз замолчит, пока партнёр не настроит оборудование
                    заново.
                  </p>
                </>
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
        body: { portNumber },
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

  const failed = [list.error, addPort.error, assign.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );
  const ports = list.data?.ports ?? [];

  return (
    <div className="flex flex-col gap-2">
      {canChange && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер порта</span>
            <Input
              className="num w-[100px]"
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
            disabled={portNumber.trim() === '' || addPort.isPending}
            onClick={() => {
              addPort.mutate();
            }}
          >
            Добавить порт
          </Button>
        </div>
      )}

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <div className="max-w-[600px] rounded-md border border-border bg-card">
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

            {ports.map((port) => (
              <TableRow key={port.id}>
                <TableCell className="num text-right">{port.port_number}</TableCell>
                <TableCell className="text-muted-foreground">
                  {PORT_STATE_NAME[port.state]}
                </TableCell>
                <TableCell>
                  {canChange ? (
                    <select
                      value={port.sim_card_id ?? ''}
                      disabled={assign.isPending}
                      onChange={(event) => {
                        assign.mutate({
                          portId: port.id,
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
                      {sims.find((sim) => sim.id === port.sim_card_id)?.msisdn ?? (
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
