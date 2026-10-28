'use client';

/**
 * Лимиты партнёра — общие части страниц «Тарифы» и «Лимиты»
 * ([ADR-0080](../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)): лимиты звонков
 * заводятся в тарифе и действуют на каждую карту этого тарифа, а страница «Лимиты» показывает остатки.
 */

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  LIMIT_PERIOD_START_DAY_MAX,
  LIMIT_WINDOWS,
  PARTNER_LIMIT_METRICS,
  type LimitMetric,
  type LimitRounding,
  type LimitSetBy,
  type LimitWindow,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import { request } from './api';
import { plural } from './format';
import { LIMIT_WINDOW_NAME } from './labels';

/** Строка `GET /partner/limits` и `GET /client/limits` — правило вместе с израсходованным (ADR-0057, ADR-0102). */
export interface LimitRow {
  readonly id: string;
  readonly client_id: string | null;
  readonly channel_id: string | null;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  /** Лимит в тарифе: действует на каждую карту этого тарифа. */
  readonly tariff_id: string | null;
  readonly window: LimitWindow;
  readonly metric: LimitMetric;
  readonly value: number;
  readonly per_sim: boolean;
  readonly rounding: LimitRounding;
  readonly period_start_day: number | null;
  readonly set_by: LimitSetBy;
  /** Пояс, в котором считаются окна (ADR-0102). */
  readonly timezone: string;
  readonly usage_sim_card_id: string | null;
  readonly resets_at: string;
  /** В единицах хранения: звонки — штуками, минуты — секундами, рубли — микроединицами. */
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

export type TariffLimit = Omit<
  LimitRow,
  'usage_sim_card_id' | 'resets_at' | 'used' | 'limit' | 'exceeded'
>;

export interface PartnerLimits {
  readonly limits: readonly LimitRow[];
  /** Лимиты тарифов как правила — видны и у тарифа без карт. */
  readonly tariff_limits: readonly TariffLimit[];
  /** Карта и тариф, по которому она работает (свой → шлюза → по умолчанию). */
  readonly sims: readonly {
    readonly id: string;
    readonly msisdn: string;
    readonly tariff_id: string;
  }[];
  readonly tariffs: readonly {
    readonly id: string;
    readonly name: string;
    readonly is_default: boolean;
  }[];
}

const LIMITS_KEY = ['partner', 'limits'] as const;

/** Чьи лимиты правятся: адрес обработчиков и ключ запроса. Партнёр по умолчанию — так было до клиента. */
export interface LimitsScope {
  readonly path: string;
  readonly key: readonly string[];
}

const PARTNER_SCOPE: LimitsScope = { path: '/partner/limits', key: LIMITS_KEY };

export function usePartnerLimits(): UseQueryResult<PartnerLimits> {
  return useQuery({
    queryKey: LIMITS_KEY,
    queryFn: () => request<PartnerLimits>('/partner/limits'),
  });
}

const METRIC_FORMS: Record<LimitMetric, readonly [string, string, string]> = {
  calls: ['звонок', 'звонка', 'звонков'],
  minutes: ['минута', 'минуты', 'минут'],
  money: ['рубль', 'рубля', 'рублей'],
};

/** «3 звонка», «500 минут», «300 рублей» — предел с единицей в нужной форме. */
export function counted(metric: LimitMetric, value: number): string {
  return `${String(value)} ${plural(value, METRIC_FORMS[metric])}`;
}

const RUBLES = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/**
 * Израсходованное и остаток в единицах хранения: звонки — штуками; минуты хранятся секундами и показываются
 * минутами с секундами; рубли хранятся микроединицами.
 */
export function amount(metric: LimitMetric, stored: number): string {
  const value = Math.max(0, stored);
  if (metric === 'calls') return String(value);
  if (metric === 'money') return `${RUBLES.format(value / 1_000_000)} ₽`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds === 0 ? `${String(minutes)} мин` : `${String(minutes)} мин ${String(seconds)} с`;
}

/** Подпись поля предела: в чём он задаётся. */
export function limitValueLabel(metric: LimitMetric): string {
  switch (metric) {
    case 'calls':
      return 'Звонков, не больше';
    case 'minutes':
      return 'Минут, не больше';
    case 'money':
      return 'Рублей, не больше';
  }
}

function useRefresh(scope: LimitsScope = PARTNER_SCOPE) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [...scope.key] });
}

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2';

/** Новый лимит в тарифе: действует на каждую карту, работающую по этому тарифу. */
export function NewTariffLimit({ tariffId }: { tariffId: string }) {
  const refresh = useRefresh();
  const [metric, setMetric] = useState<LimitMetric>('calls');
  const [span, setSpan] = useState<LimitWindow>('day');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<LimitRounding>('minute');
  const [startDay, setStartDay] = useState('');

  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1;

  return (
    <FormDialog label="Добавить лимит" title="Новый лимит в тарифе" variant="outline">
      <DialogForm
        submitLabel="Добавить лимит"
        canSubmit={valid}
        onSubmit={async () => {
          await request<unknown>('/partner/limits', {
            method: 'POST',
            body: {
              scope: 'tariff',
              tariffId,
              metric,
              window: span,
              value: number,
              ...(metric === 'minutes' ? { rounding } : {}),
              ...(span === 'month' && startDay !== '' ? { periodStartDay: Number(startDay) } : {}),
            },
          });
          setValue('');
          await refresh();
        }}
      >
        <DialogField label="Что считать">
          <select
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value as LimitMetric);
            }}
            className={SELECT_CLASS}
          >
            {PARTNER_LIMIT_METRICS.map((item) => (
              <option key={item} value={item}>
                {item === 'calls' ? 'Звонки' : 'Минуты разговора'}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Окно">
          <select
            value={span}
            onChange={(event) => {
              setSpan(event.target.value as LimitWindow);
            }}
            className={SELECT_CLASS}
          >
            {LIMIT_WINDOWS.map((item) => (
              <option key={item} value={item}>
                {LIMIT_WINDOW_NAME[item]}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label={limitValueLabel(metric)} hint="На каждую карту отдельно">
          <Input
            required
            type="number"
            className="num"
            min={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogField>

        {metric === 'minutes' && (
          <DialogField label="Счёт минут">
            <select
              value={rounding}
              onChange={(event) => {
                setRounding(event.target.value as LimitRounding);
              }}
              className={SELECT_CLASS}
            >
              <option value="minute">Поминутно — каждый разговор до целой минуты</option>
              <option value="second">Посекундно</option>
            </select>
          </DialogField>
        )}

        {span === 'month' && (
          <DialogField label="Пакет обновляется" hint="Пусто — первого числа">
            <Input
              type="number"
              className="num"
              min={1}
              max={LIMIT_PERIOD_START_DAY_MAX}
              placeholder="1"
              value={startDay}
              onChange={(event) => {
                setStartDay(event.target.value);
              }}
            />
          </DialogField>
        )}
      </DialogForm>
    </FormDialog>
  );
}

export function ChangeLimit({
  row,
  scope = PARTNER_SCOPE,
}: {
  row: Pick<TariffLimit, 'id' | 'metric' | 'value'>;
  scope?: LimitsScope;
}) {
  const refresh = useRefresh(scope);
  const [value, setValue] = useState(String(row.value));
  const number = Number(value);
  return (
    <FormDialog label="Изменить" title="Изменить лимит" variant="outline" size="sm">
      <DialogForm
        submitLabel="Сохранить"
        canSubmit={Number.isInteger(number) && number >= 1 && number !== row.value}
        onSubmit={async () => {
          await request<unknown>(`${scope.path}/${row.id}`, {
            method: 'PATCH',
            body: { value: number },
          });
          await refresh();
        }}
      >
        <DialogField label={limitValueLabel(row.metric)} hint="Израсходованное не обнуляется">
          <Input
            required
            autoFocus
            type="number"
            className="num"
            min={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

export function RemoveLimit({
  row,
  scope = PARTNER_SCOPE,
}: {
  row: Pick<TariffLimit, 'id' | 'metric' | 'value' | 'window'>;
  scope?: LimitsScope;
}) {
  const refresh = useRefresh(scope);
  return (
    <ConfirmAction
      label="Удалить"
      title="Удалить лимит"
      consequence={
        <p>
          Лимит {counted(row.metric, row.value)} {LIMIT_WINDOW_NAME[row.window]} перестанет
          действовать, израсходованное по нему обнулится.
        </p>
      }
      confirmLabel="Удалить лимит"
      onConfirm={async () => {
        await request<unknown>(`${scope.path}/${row.id}`, { method: 'DELETE' });
        await refresh();
      }}
    />
  );
}
