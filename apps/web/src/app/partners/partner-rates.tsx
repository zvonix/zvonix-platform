'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROUNDING_MODES,
  TERMINATION_KINDS,
  type Rounding,
  type TerminationKind,
} from '@zvonix/shared';
import { useState } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
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
import { request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { ROUNDING_NAME } from '@/lib/labels';
import { money, numberFromInput } from '@/lib/money';
import { TERMINATION_KIND_NAME } from '@/lib/labels';

interface Rate {
  readonly id: string;
  /** Пусто — строка, записанная до тарифов: цена тарифа по умолчанию (ADR-0056). */
  readonly tariff_id: string | null;
  /** Пусто — цена на все операторы. */
  readonly operator_id: string | null;
  readonly termination_kind: TerminationKind;
  readonly region: string | null;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: Rounding;
  readonly effective_from: string;
}

/**
 * Цены партнёра по направлениям.
 *
 * Направление — это **оператор и регион**, а не префикс номера: из-за переносимости
 * номер ничего не говорит об операторе
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)). Регион пустой
 * означает «любой», и такая цена работает там, где региональной нет.
 *
 * Записи не редактируются, а добавляются: вызов, тарифицированный вчера, не должен
 * переоцениваться сегодняшней ценой. Поэтому в списке видна вся история, свежее сверху.
 */
interface Tariff {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
}

/** Значение пункта «Все операторы»: цена без оператора (ADR-0056). */
const ALL_OPERATORS = '*';

export function PartnerRates({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const operators = useOperators();

  // Тарифы партнёра (ADR-0056): цена принадлежит тарифу, тариф выбирается у шлюза и SIM.
  const tariffs = useQuery({
    queryKey: ['partner-tariffs', partnerId],
    queryFn: () => request<{ tariffs: Tariff[] }>(`/partners/${partnerId}/tariffs`),
  });
  const tariffName = (id: string | null): string => {
    const rows = tariffs.data?.tariffs ?? [];
    const found =
      id === null ? rows.find((row) => row.is_default) : rows.find((row) => row.id === id);
    return found?.name ?? '—';
  };

  const list = useQuery({
    queryKey: ['partner-rates', partnerId],
    queryFn: () => request<{ rates: Rate[] }>(`/partner-rates?partnerId=${partnerId}`),
  });

  const add = useMutation({
    mutationFn: (draft: RateDraft) =>
      request<unknown>('/partner-rates', { method: 'POST', body: { partnerId, ...draft } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['partner-rates', partnerId] });
      // Сужение коридора после назначения цены видно только этим списком,
      // и новая цена могла как создать нарушение, так и снять его.
      await queryClient.invalidateQueries({ queryKey: ['price-bands', 'violations'] });
    },
  });

  const rates = list.data?.rates ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Цены по направлениям</h3>
        {canChange && (
          <FormDialog label="Назначить цену" title="Новая цена" variant="outline">
            <NewRateForm
              tariffs={tariffs.data?.tariffs ?? []}
              onAdd={(draft) => add.mutateAsync(draft)}
            />
          </FormDialog>
        )}
      </div>

      {list.data !== undefined && rates.length === 0 && (
        <p className="text-warn">
          Цен нет: вызовы через этого партнёра отклоняются с причиной «нет тарифа».
        </p>
      )}

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="max-w-[900px] rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Тариф</TableHead>
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8">Регион</TableHead>
              <TableHead className="h-8 text-right">За минуту</TableHead>
              <TableHead className="h-8 text-right">За соединение</TableHead>
              <TableHead className="h-8 text-right">Шаг</TableHead>
              <TableHead className="h-8 text-right">Минимум</TableHead>
              <TableHead className="h-8">Округление</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={10} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {rates.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell>{tariffName(rate.tariff_id)}</TableCell>
                <TableCell>
                  {rate.operator_id === null ? (
                    <span className="font-semibold">Все операторы</span>
                  ) : (
                    (operators.nameOf(rate.operator_id) ?? (
                      <span className="num text-faint">{rate.operator_id}</span>
                    ))
                  )}
                </TableCell>
                <TableCell>{TERMINATION_KIND_NAME[rate.termination_kind]}</TableCell>
                <TableCell>
                  {rate.region ?? <span className="text-muted-foreground">все</span>}
                </TableCell>
                <TableCell className="num text-right">{money(rate.price_per_minute)}</TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {money(rate.connection_fee)}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {rate.billing_increment_seconds} с
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {rate.minimum_duration_seconds} с
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ROUNDING_NAME[rate.rounding]}
                </TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(rate.effective_from)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface RateDraft {
  /** Не назван — тариф партнёра по умолчанию. */
  readonly tariffId?: string;
  /** `null` — цена на все операторы. */
  readonly operatorId: string | null;
  readonly terminationKind: TerminationKind;
  readonly region?: string;
  readonly pricePerMinute: string;
  readonly connectionFee: string;
  readonly billingIncrementSeconds: string;
  readonly minimumDurationSeconds: string;
  readonly rounding: Rounding;
}

/** Назначение цены — поля окна «Новая цена». */
function NewRateForm({
  tariffs,
  onAdd,
}: {
  tariffs: readonly Tariff[];
  onAdd: (draft: RateDraft) => Promise<unknown>;
}) {
  const operators = useOperators();
  const [tariffId, setTariffId] = useState('');
  const [operatorId, setOperatorId] = useState(ALL_OPERATORS);
  const [terminationKind, setTerminationKind] = useState<TerminationKind>('sim');
  const [region, setRegion] = useState('');
  const [pricePerMinute, setPricePerMinute] = useState('');
  const [connectionFee, setConnectionFee] = useState('0');
  const [increment, setIncrement] = useState('1');
  const [minimum, setMinimum] = useState('0');
  const [rounding, setRounding] = useState<Rounding>('half_away_from_zero');

  return (
    <DialogForm
      submitLabel="Назначить цену"
      canSubmit={operatorId !== '' && pricePerMinute.trim() !== ''}
      onSubmit={() =>
        onAdd({
          ...(tariffId === '' ? {} : { tariffId }),
          operatorId: operatorId === ALL_OPERATORS ? null : operatorId,
          terminationKind,
          ...(region.trim() === '' ? {} : { region: region.trim() }),
          pricePerMinute: numberFromInput(pricePerMinute),
          connectionFee: numberFromInput(connectionFee),
          billingIncrementSeconds: increment,
          minimumDurationSeconds: minimum,
          rounding,
        })
      }
    >
      <DialogField label="Тариф">
        <select
          value={tariffId}
          onChange={(event) => {
            setTariffId(event.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
        >
          <option value="">по умолчанию</option>
          {tariffs.map((tariff) => (
            <option key={tariff.id} value={tariff.id}>
              {tariff.name}
            </option>
          ))}
        </select>
      </DialogField>

      <DialogField label="Оператор">
        <select
          value={operatorId}
          onChange={(event) => {
            setOperatorId(event.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
        >
          <option value={ALL_OPERATORS}>Все операторы</option>
          {operators.rows.map((operator) => (
            <option key={operator.id} value={operator.id}>
              {operator.name}
            </option>
          ))}
        </select>
      </DialogField>

      <DialogField label="Регион">
        <Input
          value={region}
          placeholder="все регионы"
          onChange={(event) => {
            setRegion(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Через что">
        {/*
          Способ терминации — измерение цены, а не свойство железа (ADR-0040):
          внутри своей сети SIM почти бесплатна, транзит платный всегда. Одна цена
          на оба означала бы, что партнёр не может назвать настоящую ни для одного.
        */}
        <select
          value={terminationKind}
          onChange={(event) => {
            setTerminationKind(event.target.value as TerminationKind);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
        >
          {TERMINATION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {TERMINATION_KIND_NAME[kind]}
            </option>
          ))}
        </select>
      </DialogField>

      <DialogField label="Округление">
        <select
          value={rounding}
          onChange={(event) => {
            setRounding(event.target.value as Rounding);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
        >
          {ROUNDING_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {ROUNDING_NAME[mode]}
            </option>
          ))}
        </select>
      </DialogField>

      <DialogField label="За минуту, ₽">
        <Input
          className="num"
          value={pricePerMinute}
          onChange={(event) => {
            setPricePerMinute(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="За соединение, ₽">
        <Input
          className="num"
          value={connectionFee}
          onChange={(event) => {
            setConnectionFee(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Шаг, с" hint="1 — посекундно, 60 — поминутно.">
        <Input
          className="num"
          value={increment}
          onChange={(event) => {
            setIncrement(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Минимум, с">
        <Input
          className="num"
          value={minimum}
          onChange={(event) => {
            setMinimum(event.target.value);
          }}
        />
      </DialogField>

      <p className="text-muted-foreground sm:col-span-2">
        Цена проверяется по действующему коридору и начинает действовать сейчас. Прежние записи
        остаются: по ним тарифицированы прошлые вызовы.
      </p>
    </DialogForm>
  );
}
