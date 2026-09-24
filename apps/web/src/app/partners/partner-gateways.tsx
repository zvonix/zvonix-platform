'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  REGISTRABLE_GATEWAY_STATUSES,
  type GatewayPortState,
  type GatewayStatus,
  type GatewaySuspendedBy,
  type GatewayType,
  type SimStatus,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { StatusDialog } from '@/components/status-dialog';
import type { IssuedCredentials, SipAccount } from '@/components/sip-credentials';
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
import { atMost } from '@/lib/wait';
import { moment } from '@/lib/format';
import {
  GATEWAY_LOCK_MEANING,
  GATEWAY_STATUS_MEANING,
  GATEWAY_STATUS_NAME,
  GATEWAY_SUSPENDED_BY_NAME,
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
  /** Кто выключил: задан ровно у `suspended` (ADR-0047). */
  readonly suspended_by: GatewaySuspendedBy | null;
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
 *
 * Выданный пароль SIP уходит наверх (`onIssued`) и показывается наверху карточки партнёра:
 * пароль показывается один раз, и панель с ним не должна пропадать вместе с закрытым окном
 * или обновлённым списком шлюзов.
 */
export function PartnerGateways({
  partnerId,
  sims,
  onIssued,
}: {
  partnerId: string;
  sims: SimOption[];
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ['gateways', partnerId],
    queryFn: () => request<{ gateways: Gateway[] }>(`/gateways?partnerId=${partnerId}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['gateways', partnerId] });
  };

  const create = useMutation({
    mutationFn: (draft: GatewayDraft) =>
      request<{ account: SipAccount }>('/gateways', {
        method: 'POST',
        body: { partnerId, ...draft },
      }),
    onSuccess: async (data, draft) => {
      onIssued({ title: `Доступ SIP для шлюза «${draft.name}»`, account: data.account });
      await invalidate();
    },
  });

  // Действия над шлюзом — своими мутациями: их отказ показывается в их окне
  // и не должен повторяться в общей строке ошибок.
  const changeStatus = useMutation({
    mutationFn: (input: { gateway: Gateway; status: GatewayStatus }) =>
      request<unknown>(`/gateways/${input.gateway.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const reissue = useMutation({
    mutationFn: (gateway: Gateway) =>
      request<{ account: SipAccount }>(`/gateways/${gateway.id}/credentials`, { method: 'POST' }),
    onSuccess: (data, gateway) => {
      onIssued({ title: `Новый доступ SIP для шлюза «${gateway.name}»`, account: data.account });
      void invalidate();
    },
  });

  // Отказы заведения, состояния и доступа показывают их окна, здесь — только отказ списка.
  const failed = asApiError(list.error);
  const busy = changeStatus.isPending || reissue.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Шлюзы</h3>
        {canChange && (
          <FormDialog label="Добавить шлюз" title="Новый шлюз" variant="outline">
            <NewGatewayForm onCreate={(draft) => create.mutateAsync(draft)} />
          </FormDialog>
        )}
      </div>

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
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
              <GatewayRow
                key={gateway.id}
                gateway={gateway}
                sims={sims}
                busy={busy}
                onChangeStatus={(status) => changeStatus.mutateAsync({ gateway, status })}
                onReissue={() => reissue.mutateAsync(gateway)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface GatewayDraft {
  readonly name: string;
  readonly type: GatewayType;
  readonly model?: string;
  readonly portCount: number;
}

/** Заведение шлюза — поля окна «Новый шлюз». */
function NewGatewayForm({ onCreate }: { onCreate: (draft: GatewayDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<GatewayType>('goip');
  const [model, setModel] = useState('');
  const [portCount, setPortCount] = useState('8');

  const ports = integerFromInput(portCount);
  const portsValid = ports !== undefined && ports <= MAX_PORTS;
  const nameValid = name.trim().length >= 2;

  return (
    <DialogForm
      submitLabel="Добавить шлюз"
      canSubmit={nameValid && portsValid}
      onSubmit={() =>
        onCreate({
          name: name.trim(),
          type,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          portCount: ports ?? 0,
        })
      }
    >
      <DialogField
        label="Название"
        hint={name !== '' && !nameValid ? 'Не короче двух знаков.' : undefined}
      >
        <Input
          value={name}
          autoComplete="off"
          autoFocus
          placeholder="GOIP в Казани"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Вид">
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
      </DialogField>

      <DialogField label="Модель">
        <Input
          value={model}
          autoComplete="off"
          placeholder="необязательно"
          onChange={(event) => {
            setModel(event.target.value);
          }}
        />
      </DialogField>

      <DialogField
        label="Портов"
        hint={portsValid ? undefined : `Целое число от 0 до ${String(MAX_PORTS)}.`}
      >
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

      <p className="text-muted-foreground sm:col-span-2">
        {/*
          Запись типа `android` не может писать разговор (ADR-0012), и канал
          с требованием записи на неё не маршрутизируется. Сказать это здесь дешевле,
          чем разбирать потом «почему клиент не звонит через этот шлюз».
        */}
        Шлюз заведётся в состоянии «ждёт»: доступ SIP выдан, но регистрация не пройдёт, пока вы не
        переведёте его в «работает». Через шлюз вида «Android» не пойдут каналы с обязательной
        записью — там она технически невозможна.
      </p>
    </DialogForm>
  );
}

function GatewayRow({
  gateway,
  sims,
  busy,
  onChangeStatus,
  onReissue,
}: {
  gateway: Gateway;
  sims: SimOption[];
  busy: boolean;
  onChangeStatus: (status: GatewayStatus) => Promise<unknown>;
  onReissue: () => Promise<unknown>;
}) {
  const canChange = useCanChange();
  // Выключенный самим партнёром шлюз администратор может запереть: состояние то же,
  // источник — площадка, и партнёр больше не включит и не спишет его (ADR-0047).
  const lockable = gateway.status === 'suspended' && gateway.suspended_by === 'partner';
  const retired = gateway.status === 'retired';

  return (
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
        {gateway.suspended_by !== null && (
          <span className="block text-muted-foreground">
            {GATEWAY_SUSPENDED_BY_NAME[gateway.suspended_by]}
          </span>
        )}
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
        {/*
          Состояние и доступ — в строке, а не в окне портов: окно поверх окна не открывается.
          Переходов у шлюза до четырёх, и кнопка на каждый растягивала строку; теперь
          одна кнопка и окно с вариантами (`StatusDialog`).
        */}
        <div className="flex flex-wrap items-center justify-end gap-1">
          {canChange && retired && <span className="text-muted-foreground">выведен навсегда</span>}

          {canChange && !retired && (
            <StatusDialog
              subject={`шлюз «${gateway.name}»`}
              current={GATEWAY_STATUS_NAME[gateway.status]}
              disabled={busy}
              options={GATEWAY_STATUSES.filter(
                (status) => status !== gateway.status || (lockable && status === 'suspended'),
              ).map((status) => {
                const lock = status === gateway.status;
                return {
                  value: status,
                  action: lock ? 'Приостановить площадкой' : STATUS_ACTION[status],
                  meaning: lock ? GATEWAY_LOCK_MEANING : GATEWAY_STATUS_MEANING[status],
                  danger: status !== 'active',
                };
              })}
              onChange={onChangeStatus}
            />
          )}

          {canChange && !retired && (
            <ConfirmAction
              label="Новый доступ"
              title={`Перевыпустить доступ шлюза «${gateway.name}»`}
              consequence={
                <p>
                  Имя и пароль SIP меняются сразу. Шлюз потеряет регистрацию и замолчит, пока
                  партнёр не введёт новые данные в настройках оборудования. Идущие разговоры не
                  рвутся.
                </p>
              }
              confirmLabel="Перевыпустить"
              disabled={busy}
              onConfirm={onReissue}
            />
          )}

          <FormDialog
            label="Порты"
            title={`Порты шлюза «${gateway.name}»`}
            description={
              retired
                ? 'Шлюз выведен навсегда: состояние больше не меняется, SIM из его портов вынуты.'
                : 'Какая SIM стоит в каком порту.'
            }
            variant="outline"
            wide
          >
            <div className="min-h-0 overflow-y-auto px-5 pb-5">
              <GatewayPorts gatewayId={gateway.id} sims={sims} />
            </div>
          </FormDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Порты шлюза и установленные в них SIM.
 *
 * Спрашиваются только в открытом окне портов: у каждого шлюза свой список, и запрос
 * на шлюз превратил бы открытие карточки партнёра в десяток обращений. Окно показывает
 * и свои отказы — добавления порта и установки SIM.
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (portValid && !addPort.isPending) addPort.mutate();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер порта</span>
            <Input
              className="num w-[140px]"
              inputMode="numeric"
              autoComplete="off"
              value={portNumber}
              placeholder="как на корпусе"
              onChange={(event) => {
                setPortNumber(event.target.value);
              }}
            />
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={!portValid}>
            {addPort.isPending ? 'Добавляем…' : 'Добавить порт'}
          </Button>
          {portNumber !== '' && !portValid && (
            <p className="w-full text-warn">Номер порта — целое число от 1 до {MAX_PORTS}.</p>
          )}
        </form>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
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
