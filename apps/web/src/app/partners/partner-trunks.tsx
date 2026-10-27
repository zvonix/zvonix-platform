'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GATEWAY_STATUSES,
  REGISTRABLE_GATEWAY_STATUSES,
  type GatewayStatus,
  type GatewaySuspendedBy,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { TestCallButton } from '@/components/test-call';
import { EditTrunkForm, NewTrunkForm } from '@/components/trunk-forms';
import { Button } from '@/components/ui/button';
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
import { GATEWAY_STATUS_NAME, GATEWAY_SUSPENDED_BY_NAME, usableTone } from '@/lib/labels';

const COLUMNS = 6;

interface Trunk {
  readonly id: string;
  readonly node_id: string | null;
  readonly name: string;
  readonly status: GatewayStatus;
  /** Кто выключил: порог отказов срабатывает и на транк (ADR-0047). */
  readonly suspended_by: GatewaySuspendedBy | null;
  readonly sip_username: string;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly has_secret: boolean;
  readonly max_concurrent_calls: number;
}

interface Node {
  readonly id: string;
  readonly name: string;
}

/**
 * Что означает состояние **транка** — для подтверждения.
 *
 * Своё, а не общее со шлюзом: SIM у транка нет, и «SIM вынимаются из портов»
 * здесь было бы неправдой.
 */
const TRUNK_STATUS_MEANING: Record<GatewayStatus, string> = {
  pending: 'Регистрация у провайдера не поднимается, вызовы через транк не идут.',
  active: 'Узел регистрируется у провайдера, транк участвует в отборе под вызовы.',
  suspended:
    'Регистрация у провайдера снимается, новые вызовы через транк не идут. Идущие разговоры не рвутся. Вернуть можно.',
  retired: 'Транк выводится навсегда: вернуть его в работу нельзя, только завести новый.',
};

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * SIP-транки партнёра ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Второй род ёмкости рядом со шлюзами и SIM. Отличается тем, что **регистрация идёт
 * в обратную сторону**: не он к нам, а мы к нему. Отсюда и адрес провайдера, и пароль,
 * который платформа обязана уметь предъявить, — единственный такой в проекте.
 *
 * Пароль после сохранения не показывается никогда: в ответах API его нет, есть только
 * признак, что он задан. Заменить можно, посмотреть — нет.
 *
 * Состояние меняется выбором и кнопкой «Применить», а не прямо в выпадающем списке:
 * там перебор стрелками с клавиатуры отправлял запрос на каждое нажатие, включая
 * «Выведен» (ui-review, 2026-09-14).
 */
export function PartnerTrunks({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ['sip-trunks', partnerId],
    queryFn: () => request<{ trunks: Trunk[] }>(`/sip-trunks?partnerId=${partnerId}`),
  });

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await request<{ nodes: Node[] }>('/nodes')).nodes,
    staleTime: 60_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sip-trunks', partnerId] });
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<unknown>('/sip-trunks', { method: 'POST', body: { partnerId, ...body } }),
    onSuccess: refresh,
  });

  const update = useMutation({
    mutationFn: (input: { id: string; changes: Record<string, unknown> }) =>
      request<unknown>(`/sip-trunks/${input.id}`, { method: 'PATCH', body: input.changes }),
    onSuccess: refresh,
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/gateways/${id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: refresh,
  });

  const confirmStatus = useMutation({
    mutationFn: (input: { id: string; status: GatewayStatus }) =>
      request<unknown>(`/gateways/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(refresh()),
  });

  // Отказы заведения и правки показывают их окна, здесь — только отказы списка и включения.
  const failed = asApiError(list.error ?? activate.error);
  const trunks = list.data?.trunks ?? [];
  const busy = activate.isPending || confirmStatus.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">SIP-транки</h3>
        {canChange && (
          <FormDialog
            label="Добавить транк"
            title="Новый транк"
            variant="outline"
            className="ml-auto"
          >
            <NewTrunkForm
              nodes={{
                list: nodes.data ?? [],
                ready: nodes.isSuccess,
                error: asApiError(nodes.error),
              }}
              onCreate={(body) => create.mutateAsync(body)}
            />
          </FormDialog>
        )}
      </div>

      <p className="text-muted-foreground">
        Ёмкость без SIM: вызовы уходят через транзитного оператора по интернету. Регистрация идёт от
        нас к провайдеру, поэтому нужны его адрес и учётные данные — либо доступ по адресу, если
        провайдер узнаёт нас по IP. Транк привязан к узлу: поднимает регистрацию именно он.
      </p>

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Транк</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Провайдер</TableHead>
              <TableHead className="h-8">Доступ</TableHead>
              <TableHead className="h-8 text-right">Каналов</TableHead>
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

            {trunks.length === 0 && list.isSuccess && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Транков нет. Это не обязательный род ёмкости: партнёр может работать только SIM.
                </TableCell>
              </TableRow>
            )}

            {trunks.map((trunk) => (
              <TableRow key={trunk.id}>
                <TableCell>
                  {trunk.name}
                  <span className="num block text-faint" translate="no">
                    {trunk.sip_username}
                  </span>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <span
                      className={`rounded-sm px-1.5 py-0.5 ${usableTone(
                        REGISTRABLE_GATEWAY_STATUSES.includes(trunk.status),
                      )}`}
                    >
                      {GATEWAY_STATUS_NAME[trunk.status]}
                    </span>
                    {trunk.suspended_by !== null && (
                      <span className="text-muted-foreground">
                        {GATEWAY_SUSPENDED_BY_NAME[trunk.suspended_by]}
                      </span>
                    )}
                    {canChange && (
                      <TrunkStatus
                        // Новый выбор после смены состояния: прежний мог совпасть с новым.
                        key={`${trunk.id}:${trunk.status}`}
                        trunk={trunk}
                        busy={busy}
                        onActivate={() => {
                          activate.mutate(trunk.id);
                        }}
                        onConfirm={(status) => confirmStatus.mutateAsync({ id: trunk.id, status })}
                      />
                    )}
                  </div>
                </TableCell>

                <TableCell className="num" translate="no">
                  {trunk.proxy_host}
                </TableCell>

                <TableCell className="whitespace-normal">
                  {trunk.registers_outbound ? (
                    <>
                      регистрация
                      <span className="num block text-faint">
                        {trunk.outbound_username ?? '—'}
                        {trunk.has_secret ? ' · пароль задан' : ' · пароля нет'}
                      </span>
                    </>
                  ) : (
                    <>
                      по адресу
                      <span className="block text-faint">провайдер узнаёт нас по IP</span>
                    </>
                  )}
                </TableCell>

                <TableCell className="num text-right">{trunk.max_concurrent_calls}</TableCell>

                <TableCell>
                  {canChange && (
                    <div className="flex flex-wrap gap-2">
                      <FormDialog
                        label="Настроить"
                        title={`Настроить транк «${trunk.name}»`}
                        variant="outline"
                      >
                        <EditTrunkForm
                          trunk={trunk}
                          onSave={(changes) => update.mutateAsync({ id: trunk.id, changes })}
                        />
                      </FormDialog>
                      {trunk.status !== 'retired' && (
                        <TestCallButton
                          scope="admin"
                          subject={{ kind: 'trunk', id: trunk.id, name: trunk.name }}
                        />
                      )}
                    </div>
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

/**
 * Смена состояния транка: выбор, затем «Применить».
 *
 * Включение применяется сразу, остальное — через подтверждение с последствием.
 * Выведенный транк состояние не меняет: вывод окончательный.
 */
function TrunkStatus({
  trunk,
  busy,
  onActivate,
  onConfirm,
}: {
  trunk: Trunk;
  busy: boolean;
  onActivate: () => void;
  onConfirm: (status: GatewayStatus) => Promise<unknown>;
}) {
  const options = GATEWAY_STATUSES.filter((status) => status !== trunk.status);
  const [chosen, setChosen] = useState<GatewayStatus>(options[0] ?? 'active');

  if (trunk.status === 'retired') {
    return <span className="text-muted-foreground">выведен навсегда</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <select
        aria-label={`Новое состояние транка «${trunk.name}»`}
        value={chosen}
        onChange={(event) => {
          setChosen(event.target.value as GatewayStatus);
        }}
        className="h-8 rounded-md border border-input bg-transparent px-1"
      >
        {options.map((status) => (
          <option key={status} value={status}>
            {GATEWAY_STATUS_NAME[status]}
          </option>
        ))}
      </select>
      {chosen === 'active' ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={onActivate}>
          Применить
        </Button>
      ) : (
        <ConfirmAction
          label="Применить"
          title={`«${GATEWAY_STATUS_NAME[chosen]}»: транк «${trunk.name}»`}
          consequence={<p>{TRUNK_STATUS_MEANING[chosen]}</p>}
          confirmLabel={`Перевести в «${GATEWAY_STATUS_NAME[chosen]}»`}
          disabled={busy}
          onConfirm={() => onConfirm(chosen)}
        />
      )}
    </div>
  );
}
