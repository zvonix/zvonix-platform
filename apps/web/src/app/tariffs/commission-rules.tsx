'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMISSION_MAX_BASIS_POINTS, type CommissionProduct } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
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
import { useClients } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { basisPointsFromPercent, money, moneyFromInput, percent } from '@/lib/money';

interface CommissionRule {
  readonly id: string;
  readonly client_id: string | null;
  readonly fixed_fee: string;
  readonly percent_basis_points: string;
  readonly effective_from: string;
}

/** Что называют слова страницы: вызовы и сообщения MAX наценяются одними и теми же правилами (ADR-0073). */
const TEXT = {
  call: {
    title: 'Наценка на звонки',
    unit: 'вызов',
    fee: 'Фикс за вызов',
    feeDialog: 'Фикс за вызов, ₽',
    noDefault:
      'Правила по умолчанию нет: клиент, у которого нет своего правила, не сможет позвонить — вызов отклонится с причиной «нет тарифа». Добавьте правило без клиента.',
    history: 'прошлые вызовы тарифицированы по тем, что действовали на момент разговора',
  },
  message: {
    title: 'Наценка на сообщения MAX',
    unit: 'сообщение',
    fee: 'Фикс за сообщение',
    feeDialog: 'Фикс за сообщение, ₽',
    noDefault:
      'Правила по умолчанию нет: сообщения уходят без наценки. Добавьте правило без клиента.',
    history: 'прошлые сообщения оценены по тем, что действовали на момент отправки',
  },
} as const;

/** Потолок доли в сотых процента — тот же, что проверяет API: выше — опечатка в разрядах. */
const maxBasisPoints = (product: CommissionProduct): number => COMMISSION_MAX_BASIS_POINTS[product];

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Наценка платформы.
 *
 * Без действующего правила маршрутизация отказывает с причиной `no_tariff` — то есть
 * **ни один вызов не тарифицируется**. Правило без клиента — умолчание платформы;
 * правило с клиентом перебивает его для этого клиента.
 *
 * Записи не редактируются, а добавляются с датой начала действия: звонок,
 * тарифицированный вчера, не должен переоцениваться сегодняшней наценкой
 * ([ADR-0010](../../../../../docs/adr/0010-model-billinga.md)).
 *
 * Добавление — окном, а в нём через подтверждение, которое называет охват и долю: форма
 * заполнена заранее, и раньше одно нажатие заводило наценку 15 % на всю площадку. Доля
 * разбирается строкой: пустое поле больше не становится наценкой 0 %, а `0,285` — 28
 * сотыми вместо отказа (ui-review, 2026-09-14).
 */
export function CommissionRules({ product }: { product: CommissionProduct }) {
  const text = TEXT[product];
  const canChange = useCanChange();
  const clients = useClients();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['commission-rules', product],
    queryFn: () => request<{ rules: CommissionRule[] }>(`/commission-rules?product=${product}`),
  });

  const listError = asApiError(list.error);
  const rules = list.data?.rules ?? [];
  const noDefault = list.data !== undefined && !rules.some((rule) => rule.client_id === null);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="font-semibold">{text.title}</h2>
        {canChange && (
          <FormDialog
            label="Добавить правило"
            title="Новое правило наценки"
            description="Начинает действовать сейчас; прежние правила не отменяются."
            variant="outline"
            className="ml-auto"
            open={open}
            onOpenChange={setOpen}
          >
            <NewCommissionRule
              product={product}
              onAdded={() => {
                setOpen(false);
              }}
            />
          </FormDialog>
        )}
      </div>

      {noDefault && (
        <p className={product === 'call' ? 'text-crit' : 'text-warn'}>{text.noDefault}</p>
      )}

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="max-w-[760px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">К кому относится</TableHead>
              <TableHead className="h-8 text-right">Доля</TableHead>
              <TableHead className="h-8 text-right">{text.fee}</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>
                  {rule.client_id === null ? (
                    <span className="text-muted-foreground">все клиенты</span>
                  ) : (
                    (clients.nameOf(rule.client_id) ?? (
                      <span className="num text-faint">{rule.client_id}</span>
                    ))
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {percent(rule.percent_basis_points)}
                </TableCell>
                <TableCell className="num text-right">{money(rule.fixed_fee)}</TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(rule.effective_from)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * Поля окна «Новое правило наценки». Кнопка окна не заводит правило сама, а открывает
 * подтверждение поверх него: оно называет охват и долю, и отказ API показывается там же.
 * Окно закрывается вызывающим, когда правило заведено.
 */
function NewCommissionRule({
  product,
  onAdded,
}: {
  product: CommissionProduct;
  onAdded: () => void;
}) {
  const text = TEXT[product];
  const maxPercent = maxBasisPoints(product) / 100;
  const queryClient = useQueryClient();
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const [fixedFee, setFixedFee] = useState('0');
  const [share, setShare] = useState('15');

  const add = useMutation({
    mutationFn: (input: { basisPoints: number; fee: string }) =>
      request<unknown>('/commission-rules', {
        method: 'POST',
        body: {
          product,
          ...(clientId === '' ? {} : { clientId }),
          fixedFee: input.fee,
          percentBasisPoints: input.basisPoints,
        },
      }),
    onSuccess: () => {
      onAdded();
      void queryClient.invalidateQueries({ queryKey: ['commission-rules', product] });
    },
  });

  const basisPoints = basisPointsFromPercent(share);
  const shareValid = basisPoints !== undefined && basisPoints <= maxBasisPoints(product);
  const fee = moneyFromInput(fixedFee);
  const ready = shareValid && fee !== undefined;
  const clientName = clients.nameOf(clientId) ?? clientId;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        <DialogField label="Клиент" wide>
          <select
            value={clientId}
            autoFocus
            onChange={(event) => {
              setClientId(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value="">все — правило по умолчанию</option>
            {clients.rows.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Доля, %">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={share}
            onChange={(event) => {
              setShare(event.target.value);
            }}
          />
        </DialogField>

        <DialogField label={text.feeDialog}>
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={fixedFee}
            onChange={(event) => {
              setFixedFee(event.target.value);
            }}
          />
        </DialogField>

        {!shareValid && (
          <p className="text-warn sm:col-span-2">
            Доля обязательна: число от 0 до {String(maxPercent)}, не больше двух знаков после
            запятой — например 15 или 12,5.
          </p>
        )}
        {fee === undefined && (
          <p className="text-warn sm:col-span-2">
            Фикс — сумма в рублях, не больше шести знаков после запятой; ноль — без фикса.
          </p>
        )}

        <p className="text-muted-foreground sm:col-span-2">
          Правило начинает действовать сейчас и не отменяет прежние: {text.history}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <ConfirmAction
          label="Добавить"
          variant="default"
          tone="neutral"
          disabled={!ready}
          title={
            clientId === ''
              ? 'Наценка по умолчанию — для всех клиентов'
              : `Наценка для клиента «${clientName}»`
          }
          consequence={
            <>
              <p>
                Доля <b className="num">{shareValid ? percent(String(basisPoints)) : ''}</b> и фикс{' '}
                <b className="num">{fee === undefined ? '' : money(fee)}</b> за {text.unit} начинают
                действовать сейчас —{' '}
                {clientId === ''
                  ? 'для всех клиентов, у которых нет своего правила.'
                  : `для клиента «${clientName}».`}
              </p>
              <p>Прежние правила не отменяются: {text.history}.</p>
            </>
          }
          confirmLabel="Добавить правило"
          onConfirm={() => add.mutateAsync({ basisPoints: basisPoints ?? 0, fee: fee ?? '0' })}
        />
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}
