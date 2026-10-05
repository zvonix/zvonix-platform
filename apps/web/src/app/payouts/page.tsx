'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { microunits, money, moneyFromInput, numberFromInput } from '@/lib/money';
import type { PartnerRow } from '../partners/partner-row';

interface Outcome {
  readonly partner_id: string;
  readonly outcome: 'paid' | 'already_paid' | 'refused';
  readonly balance: string | null;
  readonly reason: string | null;
}

const newKey = (): string => `payout-batch-${crypto.randomUUID()}`;

const todayText = (): string =>
  `Выплата за ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;

export default function PayoutsPage() {
  return (
    <ConsoleShell title="Выплаты партнёрам" requireRole={['admin', 'support']}>
      {() => <PayoutsView />}
    </ConsoleShell>
  );
}

/**
 * Выплата списком: кому сколько причитается, отметить, кому перевели, и записать одним
 * действием. Сам перевод делается вне системы — здесь он только записывается.
 * Сумма и основание живут здесь, а не в окне подтверждения: ключ партии опознаёт намерение,
 * и повтор после сбоя сети денег второй раз не запишет.
 */
function PayoutsView() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const owed = useQuery({
    queryKey: ['partners', 'owed'],
    queryFn: ({ signal }) =>
      request<{ partners: PartnerRow[] }>('/partners?owed=true&limit=200', { signal }),
  });

  // Не выбранные явно по умолчанию отмечены все; сумма по умолчанию — всё причитающееся.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  const [description, setDescription] = useState(todayText);
  const [key, setKey] = useState(newKey);
  const [results, setResults] = useState<readonly Outcome[] | undefined>(undefined);

  const rows = (owed.data?.partners ?? []).map((partner) => {
    const text = typed[partner.id] ?? numberFromInput(partner.balance);
    const parsed = moneyFromInput(text);
    const valid =
      parsed !== undefined &&
      microunits(parsed) > BigInt(0) &&
      microunits(parsed) <= microunits(partner.balance);
    return {
      partner,
      text,
      checked: !unchecked.has(partner.id),
      valid,
      amount: valid ? parsed : undefined,
    };
  });

  const selected = rows.filter((row) => row.checked);
  const invalid = selected.some((row) => !row.valid);
  const total = selected.reduce(
    (sum, row) => (row.amount === undefined ? sum : sum + microunits(row.amount)),
    BigInt(0),
  );
  const fraction = String(total % BigInt(1_000_000))
    .padStart(6, '0')
    .replace(/0+$/u, '');
  const totalText = money(
    `${String(total / BigInt(1_000_000))}${fraction === '' ? '' : `.${fraction}`}`,
  );

  const pay = useMutation({
    mutationFn: () =>
      request<{ results: Outcome[] }>('/partners/payouts', {
        method: 'POST',
        body: {
          batchKey: key,
          description,
          items: selected.map((row) => ({ partnerId: row.partner.id, amount: row.amount })),
        },
      }),
    onSuccess: (done) => {
      setResults(done.results);
      setTyped({});
      setUnchecked(new Set());
      setKey(newKey());
      void queryClient.invalidateQueries({ queryKey: ['partners'] });
      void queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const error = owed.error instanceof ApiError ? owed.error : undefined;
  const names = new Map(rows.map((row) => [row.partner.id, row.partner.name]));

  const toggle = (id: string, checked: boolean) => {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
    setKey(newKey());
  };

  return (
    <div className="flex flex-col gap-4">
      {error !== undefined && <ErrorNote error={error} />}
      {owed.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      {results !== undefined && (
        <section
          className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4"
          aria-live="polite"
        >
          <h2 className="font-semibold">Итог</h2>
          {results.map((result) => (
            <p
              key={result.partner_id}
              className={result.outcome === 'refused' ? 'text-crit' : 'text-ok'}
            >
              {names.get(result.partner_id) ?? result.partner_id}:{' '}
              {result.outcome === 'paid' &&
                `выплата записана, причитается ${money(result.balance ?? '0')}`}
              {result.outcome === 'already_paid' && 'уже была записана, повторно не тронуто'}
              {result.outcome === 'refused' && `не записана — ${result.reason ?? 'отказ'}`}
            </p>
          ))}
        </section>
      )}

      {owed.data !== undefined && rows.length === 0 && (
        <p className="text-muted-foreground">Сейчас никому ничего не причитается.</p>
      )}

      {rows.length > 0 && (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.partner.id}
                className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[auto_1fr_auto_9rem]"
              >
                <input
                  type="checkbox"
                  className="size-6"
                  aria-label={`Выплатить партнёру ${row.partner.name}`}
                  checked={row.checked}
                  disabled={!canChange}
                  onChange={(event) => {
                    toggle(row.partner.id, event.target.checked);
                  }}
                />
                <span>{row.partner.name}</span>
                <span className="num col-start-2 text-muted-foreground sm:col-start-auto sm:text-right">
                  причитается {money(row.partner.balance)}
                </span>
                <Input
                  className="num col-start-2 sm:col-start-auto"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={`Сумма выплаты, ₽ — ${row.partner.name}`}
                  aria-invalid={row.checked && !row.valid}
                  disabled={!canChange || !row.checked}
                  value={row.text}
                  onChange={(event) => {
                    setTyped((current) => ({ ...current, [row.partner.id]: event.target.value }));
                    setKey(newKey());
                  }}
                />
              </li>
            ))}
          </ul>

          {canChange && (
            <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted-foreground">Основание</span>
                <Input
                  autoComplete="off"
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setKey(newKey());
                  }}
                />
              </label>
              <ConfirmAction
                label={`Записать выплаты (${String(selected.length)}) на ${totalText}`}
                title={`Записать выплаты на ${totalText}`}
                consequence={
                  <p>
                    Партнёрам ({String(selected.length)}) будет записана выплата на общую сумму{' '}
                    <b className="num">{totalText}</b>: причитающееся уменьшится. Сам перевод
                    делается вне системы. Отменить запись нельзя — только провести обратную.
                  </p>
                }
                confirmLabel={`Записать на ${totalText}`}
                tone="neutral"
                variant="default"
                size="default"
                disabled={selected.length === 0 || invalid || description.trim().length < 2}
                onConfirm={() => pay.mutateAsync()}
              />
            </div>
          )}
          {invalid && (
            <p className="text-warn">
              Сумма — число больше нуля и не больше причитающегося, не больше шести знаков после
              запятой.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
