'use client';

import { useMutation } from '@tanstack/react-query';
import { Power, Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { paceSummary, warmupCell } from '@/components/number-pace';
import { TrunkPresence } from '@/components/presence';
import { ClippedText, HintText, StatusDot } from '@/components/status-dot';
import { HEAD, NUM, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';
import { TariffSelect } from '@/components/tariff-select';
import { TestCallButton } from '@/components/test-call';
import { TrunkCheckButton } from '@/components/trunk-check';
import { EditTrunkForm, NewTrunkForm } from '@/components/trunk-forms';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { PARTNER_RATES_KEY } from '@/lib/tariffs';
import { atMost } from '@/lib/wait';
import { EQUIPMENT_KEY, gatewayStateName, type Trunk } from './equipment';
import { asApiError, useRefresh } from './manage';

/**
 * SIP-провайдеры партнёра ([ADR-0100](../../../../../../docs/adr/0100-sip-provayder-partnyora-i-vklyuchenie-posle-proby.md)):
 * партнёр добавляет, настраивает, проверяет звонком и включает их сам, без площадки. Адрес провайдера проверяет API —
 * внутренний или адрес самой площадки он не примет.
 */

export function AddTrunk() {
  const refresh = useRefresh();
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<unknown>('/partner/sip-trunks', { method: 'POST', body }),
    onSuccess: refresh,
  });

  return (
    <FormDialog
      label="Добавить SIP-провайдера"
      variant="outline"
      title="Новый SIP-провайдер"
      description="Адрес, логин и пароль — из кабинета провайдера"
    >
      <NewTrunkForm onCreate={(body) => add.mutateAsync(body)} />
    </FormDialog>
  );
}

export function TrunksSection({ trunks }: { trunks: readonly Trunk[] }) {
  return (
    <section aria-labelledby="trunks" className="flex flex-col gap-2">
      <h3 id="trunks" className="font-semibold">
        SIP-провайдеры
      </h3>
      {/*
        По стандарту таблицы, как строка SIM (DESIGN.md, «Таблица»; владелец, 2026-11-17): связь — точкой у названия,
        прогрев — своим столбцом, «Состояние» — только то, что мешает звонить, значки и рубильник — в конце строки.
      */}
      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Название</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Адрес</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Каналов</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Номеров</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Прогрев</TableHead>
              <TableHead className={HEAD}>
                <span className="hidden md:inline">Состояние</span>
                <span className="sr-only md:hidden">Состояние</span>
              </TableHead>
              <TableHead className={`${HEAD} w-44 ${WIDE_ONLY}`}>Тариф</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trunks.map((trunk) => (
              <TableRow key={trunk.id}>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <ClippedText text={trunk.name} width="max-w-48" />
                    <TrunkPresence link={trunk.link} now={Date.now()} dotOnly />
                  </span>
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <span
                    className="num"
                    translate="no"
                    title={
                      trunk.registers_outbound
                        ? `Регистрация у провайдера, логин ${trunk.outbound_username ?? '—'}`
                        : 'Без регистрации: провайдер узнаёт узел по адресу'
                    }
                  >
                    {trunk.proxy_host}
                  </span>
                </TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>
                  {trunk.max_concurrent_calls}
                </TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>{trunk.numbers_count}</TableCell>
                <TableCell className={WIDE_ONLY}>
                  <TrunkWarmup trunk={trunk} />
                </TableCell>
                <TableCell>
                  <TrunkStateCell trunk={trunk} />
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <TariffSelect
                    value={trunk.tariff_id}
                    inheritedId={null}
                    inheritedFrom="тариф по умолчанию"
                    kind="sip"
                    endpoint={`/partner/gateways/${trunk.id}/tariff`}
                    label={`Тариф провайдера «${trunk.name}»`}
                    invalidate={[EQUIPMENT_KEY, PARTNER_RATES_KEY]}
                  />
                </TableCell>
                <TableCell>
                  <TrunkActions trunk={trunk} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="max-w-prose text-muted-foreground">
        Цены — в <Link href="/partner/prices">«Тарифах»</Link>. Много неудачных вызовов — провайдер
        отключится сам; включите его после удачного тестового звонка.
      </p>
    </section>
  );
}

/** Прогрев провайдера — «4/14» с подсказкой, как у SIM; безлимит — словом, прогретый — пусто. */
function TrunkWarmup({ trunk }: { trunk: Trunk }) {
  if (trunk.unlimited) {
    return (
      <StatusDot
        tone="ok"
        label="безлимит"
        reason="Площадка выдала безлимит: у провайдера нет прогрева, пределов в час и в сутки, сна и пауз между звонками. Держат только его каналы и ваши лимиты"
      />
    );
  }
  if (trunk.status !== 'active') return null;
  const warmup = warmupCell(trunk.pace);
  return warmup === null ? null : <HintText label={warmup.label} reason={warmup.reason} />;
}

/**
 * Только то, что мешает провайдеру звонить: не включён, отключён площадкой или порогом, предел, сон. Включён ли он
 * вами — показывает рубильник в конце строки, слов «Включён/Выключен» нет (владелец, 2026-11-17).
 */
function TrunkStateCell({ trunk }: { trunk: Trunk }) {
  const label = gatewayStateName(trunk).toLowerCase();
  if (trunk.status === 'pending') {
    return (
      <StatusDot
        tone="warn"
        label={label}
        reason="Проверьте провайдера тестовым звонком и включите рубильником в конце строки"
        phoneDot
      />
    );
  }
  if (trunk.status === 'suspended' && trunk.suspended_by === 'failure_threshold') {
    return (
      <StatusDot
        tone="warn"
        label={label}
        reason="Много неудачных вызовов. Включите значком справа после удачного тестового звонка"
        phoneDot
      />
    );
  }
  if (trunk.status === 'suspended' && trunk.suspended_by !== 'partner') {
    return (
      <StatusDot
        tone="crit"
        label={label}
        reason="Распоряжается администратор площадки — напишите в поддержку"
        phoneDot
      />
    );
  }
  if (trunk.status !== 'active' || trunk.unlimited) return null;
  const pace = paceSummary(trunk.pace);
  return pace === null ? null : (
    <StatusDot tone={pace.tone} label={pace.label} reason={pace.reason} phoneDot />
  );
}

/**
 * Включить и выключить — рубильником в конце строки, как у карты (владелец, 2026-11-15: «почему всё разное»): включён —
 * вызовы идут, выключен вами — нет; идущие разговоры не рвутся. Отключённый порогом включается значком после удачного
 * тестового звонка; отключённым площадкой распоряжается администратор — ни рубильника, ни значка.
 */
function TrunkSwitch({ trunk }: { trunk: Trunk }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (status: 'active' | 'suspended') =>
      request<unknown>(`/partner/gateways/${trunk.id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: () => atMost(refresh()),
  });
  const error = asApiError(change.error);

  if (trunk.status === 'suspended' && trunk.suspended_by === 'failure_threshold') {
    return (
      <>
        <WithTooltip label="Включить после удачного тестового звонка">
          <Button
            {...ROW_ICON}
            aria-label="Включить"
            disabled={change.isPending}
            onClick={() => {
              change.mutate('active');
            }}
          >
            <Power aria-hidden className="size-4" />
          </Button>
        </WithTooltip>
        {error !== undefined && <ErrorNote error={error} />}
      </>
    );
  }
  if (trunk.status === 'suspended' && trunk.suspended_by !== 'partner') return null;

  const on = trunk.status === 'active';
  return (
    <span className="inline-flex flex-col gap-1 md:ml-1.5">
      <Switch
        checked={on}
        disabled={change.isPending}
        aria-label={`Провайдер «${trunk.name}» ${on ? 'включён' : 'выключен'}`}
        onCheckedChange={(checked) => {
          change.mutate(checked ? 'active' : 'suspended');
        }}
      />
      {error !== undefined && <ErrorNote error={error} />}
    </span>
  );
}

/**
 * Безлимит провайдера ([ADR-0119](../../../../../../docs/adr/0119-bezlimit-sip-provaydera-po-resheniyu-admina.md)):
 * партнёр только просит, выдаёт администратор площадки. Живёт в окне настроек, а не в строке таблицы
 * (владелец, 2026-11-17: «запрос безлимита — через настройки, а в таблице не писать»).
 */
function TrunkUnlimited({ trunk }: { trunk: Trunk }) {
  const refresh = useRefresh();
  const ask = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/sip-trunks/${trunk.id}/unlimited-request`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (trunk.unlimited) {
    return (
      <p className="border-t border-border pt-3 text-ok">
        Безлимит выдан: нет прогрева, пределов в час и в сутки, сна и пауз между звонками.
      </p>
    );
  }
  if (trunk.unlimited_requested_at !== null) {
    return (
      <p className="border-t border-border pt-3 text-muted-foreground">
        Безлимит запрошен — ждёт решения администратора.
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
      <span className="text-muted-foreground">Без прогрева и пределов на номер</span>
      <ConfirmAction
        label="Запросить безлимит"
        title={`Безлимит для провайдера «${trunk.name}»`}
        consequence={
          <>
            <p>
              Площадка бережёт номера: прогрев, пределы в час и в сутки, сон, паузы между звонками.
              Если провайдер пропускает любой поток и сам отвечает за свои номера, эти ограничения
              ему не нужны.
            </p>
            <p>
              Запрос уйдёт администратору площадки. Одновременных звонков всё равно будет не больше,
              чем каналов у провайдера ({trunk.max_concurrent_calls}).
            </p>
          </>
        }
        confirmLabel="Отправить запрос"
        tone="neutral"
        variant="outline"
        size="sm"
        onConfirm={() => ask.mutateAsync()}
      />
    </div>
  );
}

/**
 * Проверить звонком и настроить — значками с подсказкой (DESIGN.md, «Кнопки-значки»). «Удалить» — редкое и необратимое —
 * внутри окна настроек, чтобы его не задеть рядом с частыми.
 */
function TrunkActions({ trunk }: { trunk: Trunk }) {
  const refresh = useRefresh();
  const update = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      request<unknown>(`/partner/sip-trunks/${trunk.id}`, { method: 'PATCH', body: changes }),
    onSuccess: refresh,
  });
  const retire = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/gateways/${trunk.id}/status`, {
        method: 'POST',
        body: { status: 'retired' },
      }),
    onSuccess: () => atMost(refresh()),
  });
  // Снятое площадкой или порогом не удаляется: «удалил — добавил заново» обошёл бы отключение.
  const removable = trunk.status !== 'suspended' || trunk.suspended_by === 'partner';

  return (
    <RowActions>
      <TestCallButton
        scope="partner"
        subject={{ kind: 'trunk', id: trunk.id, name: trunk.name }}
        compact
      />
      <TrunkCheckButton scope="partner" trunk={trunk} />
      <FormDialog
        label={<Settings2 aria-hidden className="size-4" />}
        tooltip="Настройки провайдера"
        title={`Провайдер «${trunk.name}»`}
        {...ROW_ICON}
      >
        <EditTrunkForm
          trunk={trunk}
          onSave={(changes) => update.mutateAsync(changes)}
          revealSecret={() =>
            request<{ password: string | null }>(`/partner/sip-trunks/${trunk.id}/secret`).then(
              (reply) => reply.password,
            )
          }
          extra={<TrunkUnlimited trunk={trunk} />}
        />
        {removable && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <span className="text-muted-foreground">Провайдер больше не нужен</span>
            <ConfirmAction
              label={
                <>
                  <Trash2 aria-hidden />
                  Удалить
                </>
              }
              title={`Удалить провайдера «${trunk.name}»`}
              consequence={
                <p>Провайдер удаляется навсегда. Вернуть его нельзя — только добавить заново.</p>
              }
              confirmLabel="Удалить навсегда"
              variant="ghost"
              onConfirm={() => retire.mutateAsync()}
            />
          </div>
        )}
      </FormDialog>
      <TrunkSwitch trunk={trunk} />
    </RowActions>
  );
}
