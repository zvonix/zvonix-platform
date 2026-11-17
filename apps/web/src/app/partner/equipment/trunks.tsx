'use client';

import { useMutation } from '@tanstack/react-query';
import { Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { NumberPace } from '@/components/number-pace';
import { TrunkPresence } from '@/components/presence';
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
              <TableHead className="h-8 text-right">Каналов</TableHead>
              <TableHead className="h-8 text-right">Номеров</TableHead>
              <TableHead className="h-8">Тариф</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trunks.map((trunk) => (
              <TableRow key={trunk.id}>
                <TableCell className="whitespace-nowrap">{trunk.name}</TableCell>
                <TableCell className="whitespace-nowrap">
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
                <TableCell className="num text-right">{trunk.max_concurrent_calls}</TableCell>
                <TableCell className="num text-right">{trunk.numbers_count}</TableCell>
                <TableCell>
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
                  {/*
                    Одной строкой (владелец, 2026-11-17: «всё в несколько строк»): переключатель, связь, безлимит или
                    темп номера. Запрос безлимита и подробности — в окне настроек и в подсказках.
                  */}
                  <div className="flex items-center gap-3 whitespace-nowrap">
                    <TrunkStatus trunk={trunk} />
                    <TrunkPresence link={trunk.link} now={Date.now()} />
                    {trunk.unlimited ? (
                      <span
                        className="text-ok"
                        title="Площадка выдала безлимит: у провайдера нет прогрева, пределов в час и в сутки, сна и пауз между звонками. Держат только его каналы и ваши лимиты"
                      >
                        безлимит
                      </span>
                    ) : (
                      <NumberPace pace={trunk.pace} />
                    )}
                    {/* «Нет цен SIP» пишет сам выбор тарифа рядом — второй раз в строке не повторяется. */}
                  </div>
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

  // Переключателем, как у карты (владелец, 2026-11-15: «почему всё разное»): включён — вызовы идут, выключен вами —
  // нет; идущие разговоры не рвутся.
  const on = trunk.status === 'active';
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex cursor-pointer items-center gap-2">
        <Switch
          checked={on}
          disabled={change.isPending}
          aria-label={`Провайдер «${trunk.name}» ${on ? 'включён' : 'выключен'}`}
          onCheckedChange={(checked) => {
            change.mutate(checked ? 'active' : 'suspended');
          }}
        />
        <span className={on ? '' : 'text-muted-foreground'}>{gatewayStateName(trunk)}</span>
      </label>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
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
            Если провайдер пропускает любой поток и сам отвечает за свои номера, эти ограничения ему
            не нужны.
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
    <span className="inline-flex items-center justify-end gap-1">
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
        variant="ghost"
        size="icon-xs"
        className="size-7"
      >
        <EditTrunkForm
          trunk={trunk}
          onSave={(changes) => update.mutateAsync(changes)}
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
    </span>
  );
}
