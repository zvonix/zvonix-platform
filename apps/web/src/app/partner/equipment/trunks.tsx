'use client';

import { useMutation } from '@tanstack/react-query';
import { Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { TariffSelect, useTariffName } from '@/components/tariff-select';
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
import { request } from '@/lib/api';
import { PARTNER_RATES_KEY } from '@/lib/tariffs';
import { atMost } from '@/lib/wait';
import { EQUIPMENT_KEY, gatewayStateName, type Trunk } from './equipment';
import { AfterTestCall, asApiError, useRefresh } from './manage';

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
      description="Адрес, имя и пароль — из кабинета провайдера. Пароль после сохранения не показывается никому."
    >
      <NewTrunkForm onCreate={(body) => add.mutateAsync(body)} />
    </FormDialog>
  );
}

export function TrunksSection({ trunks }: { trunks: readonly Trunk[] }) {
  const tariffName = useTariffName();
  const fallback = tariffName(null);

  return (
    <section aria-labelledby="trunks" className="flex flex-col gap-2">
      <h3 id="trunks" className="font-semibold">
        SIP-провайдеры
      </h3>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Название</TableHead>
              <TableHead className="h-8">Адрес</TableHead>
              <TableHead className="h-8">Доступ</TableHead>
              <TableHead className="h-8 text-right">Каналов</TableHead>
              <TableHead className="h-8">Тариф</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trunks.map((trunk) => (
              <TableRow key={trunk.id}>
                <TableCell>{trunk.name}</TableCell>
                <TableCell className="num" translate="no">
                  {trunk.proxy_host}
                </TableCell>
                <TableCell>
                  {trunk.registers_outbound ? (
                    <>
                      регистрация
                      <span className="num block text-faint">{trunk.outbound_username ?? '—'}</span>
                    </>
                  ) : (
                    'по адресу'
                  )}
                </TableCell>
                <TableCell className="num text-right">{trunk.max_concurrent_calls}</TableCell>
                <TableCell>
                  <TariffSelect
                    value={trunk.tariff_id}
                    inherited={
                      fallback === undefined ? 'по умолчанию' : `по умолчанию — ${fallback}`
                    }
                    endpoint={`/partner/gateways/${trunk.id}/tariff`}
                    label={`Тариф провайдера «${trunk.name}»`}
                    invalidate={[EQUIPMENT_KEY, PARTNER_RATES_KEY]}
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <TrunkStatus trunk={trunk} />
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

/** Состояние и главное действие сейчас — как у шлюза: включить, выключить, удалить. */
function TrunkStatus({ trunk }: { trunk: Trunk }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (status: 'active' | 'suspended' | 'retired') =>
      request<unknown>(`/partner/gateways/${trunk.id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: () => atMost(refresh()),
  });
  const error = asApiError(change.error);

  const badge = (
    <span
      className={`rounded-sm px-1.5 py-0.5 ${trunk.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
    >
      {gatewayStateName(trunk)}
    </span>
  );

  if (trunk.status === 'suspended' && trunk.suspended_by === 'failure_threshold') {
    return (
      <AfterTestCall
        badge={badge}
        label="Включить"
        hint="Много неудачных вызовов. Включите после удачного тестового звонка."
        pending={change.isPending}
        error={error}
        onEnable={() => {
          change.mutate('active');
        }}
      />
    );
  }
  if (trunk.status === 'suspended' && trunk.suspended_by !== 'partner') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {badge}
        <span className="text-muted-foreground">распоряжается администратор площадки</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {badge}
        {trunk.status === 'active' ? (
          <ConfirmAction
            label="Выключить"
            title={`Выключить провайдера «${trunk.name}»`}
            consequence={
              <p>
                Через провайдера перестанут идти вызовы. Идущие разговоры не рвутся. Включить
                обратно можно здесь же.
              </p>
            }
            confirmLabel="Выключить"
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
            Включить
          </Button>
        )}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
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
    <span className="inline-flex items-center justify-end gap-1">
      <TestCallButton
        scope="partner"
        subject={{ kind: 'trunk', id: trunk.id, name: trunk.name }}
        compact
      />
      <FormDialog
        label={<Settings2 aria-hidden className="size-4" />}
        tooltip="Настройки провайдера"
        title={`Провайдер «${trunk.name}»`}
        variant="ghost"
        size="icon-xs"
        className="size-7"
      >
        <EditTrunkForm trunk={trunk} onSave={(changes) => update.mutateAsync(changes)} />
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
    </span>
  );
}
