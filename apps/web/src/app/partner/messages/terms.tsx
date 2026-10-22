'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Hint } from '@/components/hint';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { bandRange, money, moneyFromInput, numberFromInput } from '@/lib/money';

/**
 * Аккаунты и тарифы MAX партнёра ([ADR-0075](../../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)).
 *
 * Тариф — именованный набор «цена за сообщение + лимиты». Он назначается аккаунту; аккаунт без своего тарифа идёт
 * за тарифом по умолчанию. Тот же порядок, что у тарифов звонков. Модуль общий для трёх страниц: «Аккаунты MAX»
 * (назначение), «Тарифы MAX» (тарифы) и «Лимиты» (действующие лимиты) — вкладкой «Сообщения MAX».
 */

export interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly state_reason: string | null;
  readonly phone: string | null;
  /** Назначенный тариф; пусто — аккаунт идёт за тарифом по умолчанию. */
  readonly tariff_id: string | null;
  /** Действующие условия (из своего тарифа или из умолчания). */
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_hour: number | null;
  readonly limit_per_day: number | null;
  readonly warmup_enabled: boolean;
  readonly stop_line: boolean;
  readonly recommended: boolean;
  readonly warmup_day: number | null;
  readonly paused_until: string | null;
  readonly daily_limit_now: number | null;
}

export interface AccountsResponse {
  readonly enabled: boolean;
  readonly accounts: Account[];
}

interface Tariff {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly limit_per_minute: number | null;
  readonly limit_per_hour: number | null;
  readonly limit_per_day: number | null;
  readonly is_default: boolean;
  readonly accounts: number;
}

export const ACCOUNTS_KEY = ['partner', 'messenger', 'accounts'] as const;
const TARIFFS_KEY = ['partner', 'messenger', 'tariffs'] as const;

/** Аккаунты партнёра и признак, что сообщения на площадке вообще включены. */
export function useMessengerAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: ({ signal }) => request<AccountsResponse>('/partner/messenger/accounts', { signal }),
    // Состояние аккаунта сверяет площадка раз в минуту: чаще спрашивать нечего.
    refetchInterval: 30_000,
  });
}

function useMessengerTariffs() {
  return useQuery({
    queryKey: TARIFFS_KEY,
    queryFn: ({ signal }) =>
      request<{
        tariffs: Tariff[];
        /** Коридор цены сообщения от площадки; пусто — коридора нет. */
        price_band: { min_price: string | null; max_price: string | null } | null;
      }>('/partner/messenger/tariffs', { signal }),
  });
}

/** Лимиты словами: «10 в минуту, 500 в сутки» или «без ограничений». */
function limitsText(
  perMinute: number | null,
  perHour: number | null,
  perDay: number | null,
): string {
  const parts = [
    perMinute === null ? null : `${String(perMinute)} в минуту`,
    perHour === null ? null : `${String(perHour)} в час`,
    perDay === null ? null : `${String(perDay)} в сутки`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'без ограничений' : parts.join(', ');
}

// --- Аккаунт: название и тариф ----------------------------------------------------------------

/** Название аккаунта. Цена и лимиты — в тарифе. */
/** Тариф аккаунта в таблице: только название; менять — в «Настройках» аккаунта. */
export function AccountTariffName({ account }: { account: Account }) {
  const tariffs = useMessengerTariffs();
  const list = tariffs.data?.tariffs ?? [];
  if (!tariffs.isPending && list.length === 0) {
    return (
      <Link href="/partner/max-tariffs" className="text-warn underline underline-offset-2">
        Создайте тариф
      </Link>
    );
  }
  const own = list.find((tariff) => tariff.id === account.tariff_id);
  const fallback = list.find((tariff) => tariff.is_default);
  if (tariffs.isPending) return <span className="text-faint">загружаем…</span>;
  return (
    <span>
      {own?.name ?? (fallback === undefined ? 'по умолчанию' : `по умолчанию — ${fallback.name}`)}
    </span>
  );
}

/**
 * «Настройки» аккаунта одним окном: название, тариф и «рекомендованная работа» (ADR-0088, ADR-0090). Включена — лимиты тарифа не
 * действуют, работают лимиты площадки; их значения партнёру не показываются. «СТОП» в сообщениях — решение партнёра, клиент его
 * видит по каждому аккаунту (ADR-0092).
 */
export function AccountSettingsForm({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const tariffs = useMessengerTariffs();
  const [label, setLabel] = useState(account.label);
  const [tariffId, setTariffId] = useState(account.tariff_id ?? '');
  const [recommended, setRecommended] = useState(account.recommended);
  const [stopLine, setStopLine] = useState(account.stop_line);
  const valid = label.trim().length >= 2;
  const list = tariffs.data?.tariffs ?? [];
  const fallback = list.find((tariff) => tariff.is_default);
  const chosen = list.find((tariff) => tariff.id === tariffId) ?? fallback;

  const save = useMutation({
    mutationFn: async () => {
      await request<unknown>(`/partner/messenger/accounts/${account.id}`, {
        method: 'PATCH',
        body: { label: label.trim(), stopLine, recommended },
      });
      if (tariffId !== (account.tariff_id ?? '')) {
        await request<unknown>(`/partner/messenger/accounts/${account.id}/tariff`, {
          method: 'PUT',
          body: { tariffId: tariffId === '' ? null : tariffId },
        });
      }
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
        queryClient.invalidateQueries({ queryKey: TARIFFS_KEY }),
      ]),
  });

  return (
    <DialogForm submitLabel="Сохранить" canSubmit={valid} onSubmit={() => save.mutateAsync()}>
      <DialogField
        label="Название"
        wide
        hint="Как вы называете аккаунт у себя. Клиентам оно не видно."
      >
        <Input
          autoComplete="off"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </DialogField>
      {list.length > 0 && (
        <DialogField label="Тариф" wide>
          <select
            value={tariffId}
            onChange={(event) => {
              setTariffId(event.target.value);
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2"
          >
            <option value="">
              {fallback === undefined ? 'по умолчанию' : `по умолчанию — ${fallback.name}`}
            </option>
            {list.map((tariff) => (
              <option key={tariff.id} value={tariff.id}>
                {tariff.name}
              </option>
            ))}
          </select>
        </DialogField>
      )}
      <div className="flex flex-col gap-3 sm:col-span-2">
        <label className="flex items-center gap-2">
          <Switch checked={recommended} onCheckedChange={setRecommended} />
          Рекомендованная работа
          <Hint label="Что такое рекомендованная работа">
            <p>
              Аккаунт отправляет в темпе, который площадка считает безопасным: реже блокировки.
              Лимиты вашего тарифа при этом не действуют, работают лимиты площадки. Значения задаёт
              площадка.
            </p>
          </Hint>
        </label>
        {chosen !== undefined && (
          <p className={recommended ? 'text-faint' : 'text-muted-foreground'}>
            Лимиты тарифа:{' '}
            {limitsText(chosen.limit_per_minute, chosen.limit_per_hour, chosen.limit_per_day)}
            {recommended && ' — не действуют, работает рекомендованная работа'}
          </p>
        )}
        <label className="flex items-center gap-2">
          <Switch checked={stopLine} onCheckedChange={setStopLine} />
          «СТОП» в сообщениях
          <Hint label="Что такое «СТОП» в сообщениях">
            <p>
              К каждому сообщению добавляется строка «Чтобы отписаться, ответьте СТОП». Человек,
              который ответит так, больше не получит сообщений. Меньше жалоб — аккаунт реже
              блокируют. Клиенты видят, у каких аккаунтов строка включена.
            </p>
          </Hint>
        </label>
      </div>
    </DialogForm>
  );
}

// --- Тарифы -------------------------------------------------------------------------------------

function TariffForm({ tariff }: { tariff?: Tariff }) {
  const band = useMessengerTariffs().data?.price_band;
  const queryClient = useQueryClient();
  const [name, setName] = useState(tariff?.name ?? '');
  const [price, setPrice] = useState(tariff === undefined ? '' : numberFromInput(tariff.price));
  const [perMinute, setPerMinute] = useState(
    tariff?.limit_per_minute === null || tariff === undefined
      ? ''
      : String(tariff.limit_per_minute),
  );
  const [perHour, setPerHour] = useState(
    tariff?.limit_per_hour === null || tariff === undefined ? '' : String(tariff.limit_per_hour),
  );
  const [perDay, setPerDay] = useState(
    tariff?.limit_per_day === null || tariff === undefined ? '' : String(tariff.limit_per_day),
  );

  const parseLimit = (text: string): number | null | undefined => {
    if (text.trim() === '') return null;
    return /^\d{1,7}$/u.test(text.trim()) ? Number(text.trim()) : undefined;
  };
  const priceValid = moneyFromInput(price) !== undefined;
  const minuteLimit = parseLimit(perMinute);
  const hourLimit = parseLimit(perHour);
  const dayLimit = parseLimit(perDay);
  const valid =
    name.trim().length >= 1 &&
    priceValid &&
    minuteLimit !== undefined &&
    hourLimit !== undefined &&
    dayLimit !== undefined;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        price: numberFromInput(price),
        limitPerMinute: minuteLimit,
        limitPerHour: hourLimit,
        limitPerDay: dayLimit,
      };
      return tariff === undefined
        ? request<unknown>('/partner/messenger/tariffs', { method: 'POST', body })
        : request<unknown>(`/partner/messenger/tariffs/${tariff.id}`, { method: 'PATCH', body });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: TARIFFS_KEY }),
        queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
      ]),
  });

  return (
    <DialogForm
      submitLabel={tariff === undefined ? 'Создать' : 'Сохранить'}
      canSubmit={valid}
      onSubmit={() => save.mutateAsync()}
    >
      <DialogField label="Название" wide hint="Например «Основной» или «Дорогой для срочных».">
        <Input
          autoFocus={tariff === undefined}
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>
      <DialogField
        label="Цена за сообщение, ₽"
        hint={
          band === undefined || band === null
            ? 'От 0,01 до 100.'
            : `Коридор площадки: ${bandRange(band.min_price, band.max_price)} за сообщение.`
        }
      >
        <Input
          className="num"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,45"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="В минуту" hint="Пусто — без ограничения.">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={perMinute}
          onChange={(event) => {
            setPerMinute(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="В час" hint="Пусто — без ограничения. Не больше, чем в сутки.">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={perHour}
          onChange={(event) => {
            setPerHour(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="В сутки">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={perDay}
          onChange={(event) => {
            setPerDay(event.target.value);
          }}
        />
      </DialogField>
      {price.trim() !== '' && !priceValid && (
        <p className="text-warn sm:col-span-2">
          Цена — число больше нуля, не больше шести знаков после запятой: например 0,45.
        </p>
      )}
      {(minuteLimit === undefined || dayLimit === undefined) && (
        <p className="text-warn sm:col-span-2">Лимит — целое число или пусто.</p>
      )}
    </DialogForm>
  );
}

/** Вкладка «Сообщения MAX» страницы «Тарифы MAX»: тарифы партнёра, как у звонков — создать, изменить, по умолчанию. */
export function MaxTariffs() {
  const queryClient = useQueryClient();
  const list = useMessengerTariffs();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: TARIFFS_KEY }),
      queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    ]);
  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/partner/messenger/tariffs/${id}/default`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/partner/messenger/tariffs/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (list.error instanceof ApiError) return <ErrorNote error={list.error} />;
  if (list.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  const tariffs = list.data.tariffs;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <FormDialog label="Новый тариф" title="Новый тариф MAX" variant="outline">
          <TariffForm />
        </FormDialog>
        <Hint label="Что такое тариф MAX">
          <p>
            Тариф — цена за сообщение и лимиты. Назначается аккаунту; без своего тарифа аккаунт идёт
            за тарифом по умолчанию.
          </p>
        </Hint>
      </div>
      {makeDefault.error instanceof ApiError && <ErrorNote error={makeDefault.error} />}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Тариф</TableHead>
              <TableHead className="h-8 text-right">Цена за сообщение</TableHead>
              <TableHead className="h-8">Лимиты</TableHead>
              <TableHead className="h-8 text-right">Аккаунтов</TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tariffs.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="whitespace-normal text-muted-foreground">
                  Тарифов пока нет. Создайте первый — он станет тарифом по умолчанию, и аккаунты
                  начнут принимать сообщения.
                </TableCell>
              </TableRow>
            )}
            {tariffs.map((tariff) => (
              <TableRow key={tariff.id}>
                <TableCell>
                  {tariff.name}
                  {tariff.is_default && (
                    <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                      по умолчанию
                    </span>
                  )}
                </TableCell>
                <TableCell className="num text-right">{money(tariff.price)}</TableCell>
                <TableCell className="num text-muted-foreground">
                  {limitsText(tariff.limit_per_minute, tariff.limit_per_hour, tariff.limit_per_day)}
                </TableCell>
                <TableCell className="num text-right">{tariff.accounts}</TableCell>
                <TableCell className="text-right">
                  <span className="flex flex-wrap justify-end gap-2">
                    <FormDialog
                      label="Изменить"
                      title={`Тариф «${tariff.name}»`}
                      variant="outline"
                      size="xs"
                    >
                      <TariffForm tariff={tariff} />
                    </FormDialog>
                    {!tariff.is_default && (
                      <button
                        type="button"
                        disabled={makeDefault.isPending}
                        onClick={() => {
                          makeDefault.mutate(tariff.id);
                        }}
                        className="min-h-7 rounded-md border border-border px-2 hover:bg-muted"
                      >
                        По умолчанию
                      </button>
                    )}
                    {!tariff.is_default && (
                      <ConfirmAction
                        label="Удалить"
                        title={`Удалить тариф «${tariff.name}»`}
                        consequence="Тариф будет удалён. Аккаунты на нём остаться не должны: сначала назначьте им другой тариф."
                        confirmLabel="Удалить"
                        size="xs"
                        onConfirm={() => remove.mutateAsync(tariff.id)}
                      />
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
