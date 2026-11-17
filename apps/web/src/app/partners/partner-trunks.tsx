'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Infinity as InfinityIcon, Settings2, X } from 'lucide-react';
import {
  GATEWAY_STATUSES,
  REGISTRABLE_GATEWAY_STATUSES,
  type GatewayStatus,
  type GatewaySuspendedBy,
} from '@zvonix/shared';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { TestCallButton } from '@/components/test-call';
import { TrunkCheckButton } from '@/components/trunk-check';
import { TrunkAuthBlocked, TrunkReconnectButton } from '@/components/trunk-reconnect';
import { paceSummary, warmupCell, type NumberPaceView } from '@/components/number-pace';
import { TrunkPresence, type TrunkLink } from '@/components/presence';
import { EditTrunkForm, NewTrunkForm } from '@/components/trunk-forms';
import { StatusDialog } from '@/components/status-dialog';
import { ClippedText, HintText, StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
import { atMost } from '@/lib/wait';
import { GATEWAY_STATUS_NAME, GATEWAY_SUSPENDED_BY_NAME, usableTone } from '@/lib/labels';

const COLUMNS = 7;

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
  /** Номеров у провайдера (ADR-0105). */
  readonly numbers_count: number;
  /** Безлимит (ADR-0119): ограничения площадки на номер не действуют. */
  readonly unlimited: boolean;
  /** Партнёр попросил безлимит, решения нет; пусто — не просил или решено. */
  readonly unlimited_requested_at: string | null;
  readonly has_price: boolean;
  readonly link: TrunkLink | null;
  /** Остановлен из-за неверного логина или пароля (ADR-0123); пусто — нет. */
  readonly auth_blocked_at: string | null;
  readonly pace?: NumberPaceView;
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
 * Состояние меняется окном с вариантами (`StatusDialog`), а не прямо в выпадающем списке: там перебор стрелками
 * с клавиатуры отправлял запрос на каждое нажатие, включая «Выведен» (ui-review, 2026-09-14).
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

      {/*
        По стандарту таблицы (DESIGN.md, «Таблица»; владелец, 2026-11-17), как строка SIP-провайдера у партнёра: связь —
        точкой у названия, состояние — точкой и словом, второе слово — только то, что требует внимания, прогрев —
        своим столбцом, действия — значками. Смена состояния — одним окном с вариантами (`StatusDialog`), а не выбором
        и «Применить» в строке.
      */}
      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Транк</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Провайдер</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Каналов</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Номеров</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Прогрев</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
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
                  <span className="inline-flex items-center gap-1">
                    <ClippedText
                      text={trunk.name}
                      hint={`${trunk.name}. Вход на узле: ${trunk.sip_username}`}
                      width="max-w-48"
                    />
                    <TrunkPresence link={trunk.link} now={Date.now()} dotOnly />
                  </span>
                </TableCell>

                <TableCell>
                  <span className="inline-flex items-center gap-3">
                    <StatusDot
                      tone={toneOf(usableTone(REGISTRABLE_GATEWAY_STATUSES.includes(trunk.status)))}
                      label={GATEWAY_STATUS_NAME[trunk.status]}
                      reason={
                        trunk.suspended_by === null
                          ? TRUNK_STATUS_MEANING[trunk.status]
                          : `${GATEWAY_SUSPENDED_BY_NAME[trunk.suspended_by]}. ${TRUNK_STATUS_MEANING[trunk.status]}`
                      }
                    />
                    {trunk.auth_blocked_at !== null && <TrunkAuthBlocked />}
                    <TrunkAttention trunk={trunk} />
                  </span>
                </TableCell>

                <TableCell className={WIDE_ONLY}>
                  <ClippedText
                    text={trunk.proxy_host}
                    width="max-w-56"
                    hint={
                      trunk.registers_outbound
                        ? `Регистрация у провайдера, логин ${trunk.outbound_username ?? '—'}; ${trunk.has_secret ? 'пароль задан' : 'пароля нет'}`
                        : 'По адресу: провайдер узнаёт нас по IP, учётных данных нет'
                    }
                  />
                </TableCell>

                <TableCell className={`${NUM} ${WIDE_ONLY}`}>
                  {trunk.max_concurrent_calls}
                </TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>{trunk.numbers_count}</TableCell>

                <TableCell className={WIDE_ONLY}>
                  <TrunkWarmup trunk={trunk} />
                </TableCell>

                <TableCell>
                  {canChange && (
                    <RowActions>
                      {trunk.status !== 'retired' && (
                        <>
                          <TestCallButton
                            scope="admin"
                            subject={{ kind: 'trunk', id: trunk.id, name: trunk.name }}
                          />
                          <TrunkCheckButton scope="admin" trunk={trunk} />
                          {trunk.auth_blocked_at !== null && (
                            <TrunkReconnectButton
                              scope="admin"
                              trunkId={trunk.id}
                              invalidate={['sip-trunks', partnerId]}
                            />
                          )}
                        </>
                      )}
                      <FormDialog
                        label={<Settings2 aria-hidden className="size-4" />}
                        tooltip="Настроить"
                        {...ROW_ICON}
                        title={`Настроить транк «${trunk.name}»`}
                      >
                        <EditTrunkForm
                          trunk={trunk}
                          onSave={(changes) => update.mutateAsync({ id: trunk.id, changes })}
                          revealSecret={() =>
                            request<{ password: string | null }>(
                              `/sip-trunks/${trunk.id}/secret`,
                            ).then((reply) => reply.password)
                          }
                        />
                      </FormDialog>
                      <TrunkUnlimited trunk={trunk} onDone={refresh} />
                      {trunk.status !== 'retired' && (
                        <StatusDialog
                          subject={`транк «${trunk.name}»`}
                          current={GATEWAY_STATUS_NAME[trunk.status]}
                          disabled={busy}
                          options={GATEWAY_STATUSES.filter((status) => status !== trunk.status).map(
                            (status) => ({
                              value: status,
                              action: GATEWAY_STATUS_NAME[status],
                              meaning: TRUNK_STATUS_MEANING[status],
                              danger: status === 'retired' || status === 'suspended',
                            }),
                          )}
                          onChange={(status) =>
                            status === 'active'
                              ? activate.mutateAsync(trunk.id)
                              : confirmStatus.mutateAsync({ id: trunk.id, status })
                          }
                        />
                      )}
                    </RowActions>
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
 * Второе слово в «Состоянии» — только то, что требует внимания администратора, по важности: партнёр просит безлимит,
 * в тарифе нет цены SIP, номер упёрся в предел или спит. Всё в порядке — пусто.
 */
function TrunkAttention({ trunk }: { trunk: Trunk }) {
  if (!trunk.unlimited && trunk.unlimited_requested_at !== null) {
    return (
      <StatusDot
        tone="warn"
        label="просит безлимит"
        reason={`Партнёр попросил безлимит ${moment(trunk.unlimited_requested_at)}. Выдать или отклонить — значками справа`}
      />
    );
  }
  if (!trunk.has_price) {
    return (
      <StatusDot
        tone="warn"
        label="нет цены SIP"
        reason="В тарифе провайдера нет цены «через SIP»: без неё клиенты через него не звонят"
      />
    );
  }
  if (trunk.status !== 'active' || trunk.unlimited) return null;
  const pace = paceSummary(trunk.pace);
  return pace === null ? null : (
    <StatusDot tone={pace.tone} label={pace.label} reason={pace.reason} />
  );
}

/** Прогрев — «4/14» с подсказкой, как у SIM; безлимит — словом, прогретый — пусто. */
function TrunkWarmup({ trunk }: { trunk: Trunk }) {
  if (trunk.unlimited) {
    return (
      <StatusDot
        tone="ok"
        label="безлимит"
        reason="Нет прогрева, пределов в час и в сутки, сна и пауз между звонками; держат каналы провайдера и лимиты"
      />
    );
  }
  if (trunk.status !== 'active') return null;
  const warmup = warmupCell(trunk.pace);
  return warmup === null ? null : <HintText label={warmup.label} reason={warmup.reason} />;
}

/**
 * Безлимит провайдера ([ADR-0119](../../../../../docs/adr/0119-bezlimit-sip-provaydera-po-resheniyu-admina.md)):
 * решает только администратор — выдаёт по запросу партнёра или сам, отклоняет, снимает. Значками в ряду действий
 * строки; что просит партнёр — словом в «Состоянии».
 */
function TrunkUnlimited({ trunk, onDone }: { trunk: Trunk; onDone: () => Promise<void> }) {
  const decide = useMutation({
    mutationFn: (unlimited: boolean) =>
      request<unknown>(`/sip-trunks/${trunk.id}/unlimited`, {
        method: 'PUT',
        body: { unlimited },
      }),
    onSuccess: onDone,
  });
  if (trunk.status === 'retired') return null;

  if (trunk.unlimited) {
    return (
      <ConfirmAction
        label={<InfinityIcon aria-hidden className="size-4" />}
        tooltip="Снять безлимит"
        {...ROW_ICON}
        title={`Снять безлимит у провайдера «${trunk.name}»`}
        consequence={
          <p>
            К провайдеру вернётся рекомендованная работа площадки: прогрев, пределы, сон и паузы.
            Часть вызовов пойдёт через другие номера или не пройдёт.
          </p>
        }
        confirmLabel="Снять безлимит"
        onConfirm={() => decide.mutateAsync(false)}
      />
    );
  }

  const grant = (
    <ConfirmAction
      label={<InfinityIcon aria-hidden className="size-4" />}
      tooltip="Выдать безлимит"
      {...ROW_ICON}
      title={`Безлимит для провайдера «${trunk.name}»`}
      consequence={
        <p>
          У провайдера не будет прогрева, пределов в час и в сутки, сна, пауз между звонками и
          ровного шага. Одновременных звонков — не больше его каналов ({trunk.max_concurrent_calls}
          ); лимиты партнёра и клиентов действуют. Снять можно в любой момент.
        </p>
      }
      confirmLabel="Выдать безлимит"
      tone="neutral"
      onConfirm={() => decide.mutateAsync(true)}
    />
  );

  if (trunk.unlimited_requested_at === null) return grant;
  return (
    <>
      {grant}
      <ConfirmAction
        label={<X aria-hidden className="size-4" />}
        tooltip="Отклонить безлимит"
        {...ROW_ICON}
        title={`Отклонить безлимит для провайдера «${trunk.name}»`}
        consequence={
          <p>
            Провайдер продолжит работать с ограничениями площадки. Партнёр сможет попросить снова.
          </p>
        }
        confirmLabel="Отклонить"
        tone="neutral"
        onConfirm={() => decide.mutateAsync(false)}
      />
    </>
  );
}
