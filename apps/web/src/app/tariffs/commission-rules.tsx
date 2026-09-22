'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
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

/** Потолок доли в сотых процента — тот же, что проверяет API: больше 100 % — опечатка. */
const MAX_BASIS_POINTS = 10_000;

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
 * Добавление — через подтверждение, которое называет охват и долю: форма заполнена
 * заранее, и раньше одно нажатие заводило наценку 15 % на всю площадку. Доля
 * разбирается строкой: пустое поле больше не становится наценкой 0 %, а `0,285` — 28
 * сотыми вместо отказа (ui-review, 2026-09-14).
 */
export function CommissionRules() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const clients = useClients();
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [fixedFee, setFixedFee] = useState('0');
  const [share, setShare] = useState('15');

  const list = useQuery({
    queryKey: ['commission-rules'],
    queryFn: () => request<{ rules: CommissionRule[] }>('/commission-rules'),
  });

  const add = useMutation({
    mutationFn: (input: { basisPoints: number; fee: string }) =>
      request<unknown>('/commission-rules', {
        method: 'POST',
        body: {
          ...(clientId === '' ? {} : { clientId }),
          fixedFee: input.fee,
          percentBasisPoints: input.basisPoints,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['commission-rules'] });
    },
  });

  const listError = asApiError(list.error);
  const basisPoints = basisPointsFromPercent(share);
  const shareValid = basisPoints !== undefined && basisPoints <= MAX_BASIS_POINTS;
  const fee = moneyFromInput(fixedFee);
  const ready = shareValid && fee !== undefined;
  const rules = list.data?.rules ?? [];
  const noDefault = list.data !== undefined && !rules.some((rule) => rule.client_id === null);
  const clientName = clients.nameOf(clientId) ?? clientId;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="font-semibold">Наценка платформы</h2>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Отменить' : 'Добавить правило'}
          </Button>
        )}
      </div>

      {noDefault && (
        <p className="text-crit">
          Правила по умолчанию нет: клиент, у которого нет своего правила, не сможет позвонить —
          вызов отклонится с причиной «нет тарифа». Добавьте правило без клиента.
        </p>
      )}

      {canChange && open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Клиент</span>
            <select
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value);
              }}
              className="h-9 w-[240px] rounded-md border border-input bg-transparent px-2"
            >
              <option value="">все — правило по умолчанию</option>
              {clients.rows.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Доля, %</span>
            <Input
              className="num w-[100px]"
              inputMode="decimal"
              autoComplete="off"
              value={share}
              onChange={(event) => {
                setShare(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Фикс за вызов, ₽</span>
            <Input
              className="num w-[120px]"
              inputMode="decimal"
              autoComplete="off"
              value={fixedFee}
              onChange={(event) => {
                setFixedFee(event.target.value);
              }}
            />
          </label>

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
                  Доля <b className="num">{shareValid ? percent(String(basisPoints)) : ''}</b> и
                  фикс <b className="num">{fee === undefined ? '' : money(fee)}</b> за вызов
                  начинают действовать сейчас —{' '}
                  {clientId === ''
                    ? 'для всех клиентов, у которых нет своего правила.'
                    : `для клиента «${clientName}».`}
                </p>
                <p>
                  Прежние правила не отменяются: прошлые вызовы тарифицированы по тем, что
                  действовали на момент разговора.
                </p>
              </>
            }
            confirmLabel="Добавить правило"
            onConfirm={() => add.mutateAsync({ basisPoints: basisPoints ?? 0, fee: fee ?? '0' })}
          />

          {!shareValid && (
            <p className="w-full text-warn">
              Доля обязательна: число от 0 до 100, не больше двух знаков после запятой — например 15
              или 12,5.
            </p>
          )}
          {fee === undefined && (
            <p className="w-full text-warn">
              Фикс — сумма в рублях, не больше шести знаков после запятой; ноль — без фикса.
            </p>
          )}

          <p className="w-full text-muted-foreground">
            Правило начинает действовать сейчас и не отменяет прежние: прошлые вызовы тарифицированы
            по тем, что действовали на момент разговора.
          </p>
        </form>
      )}

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="max-w-[760px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">К кому относится</TableHead>
              <TableHead className="h-8 text-right">Доля</TableHead>
              <TableHead className="h-8 text-right">Фикс за вызов</TableHead>
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
