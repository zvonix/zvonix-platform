'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaymentStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { useLiveInterval } from '@/lib/live';
import { money, moneyFromInput, numberFromInput } from '@/lib/money';
import { PAYMENT_STATUS_NAME, PAYMENT_STATUS_TONE } from '@/lib/labels';

interface Payment {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly amount: string;
  readonly received_amount: string | null;
  readonly comment: string | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
}

interface Listing {
  readonly instructions: string;
  readonly payments: Payment[];
}

const KEY = ['my', 'payments'] as const;

/** Номер заявки, который клиент пишет в переводе, — первые знаки идентификатора. */
const numberOf = (id: string): string => id.slice(0, 8);

/**
 * Пополнение счёта клиентом ([ADR-0064](../../../../../../docs/adr/0064-platezhi-karkas.md)):
 * заявка на сумму, реквизиты для перевода и список заявок с их исходом. Деньги зачислит
 * администратор, когда перевод придёт.
 */
export function TopUp() {
  const queryClient = useQueryClient();
  const live = useLiveInterval();
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [created, setCreated] = useState<Payment | undefined>(undefined);

  const list = useQuery({
    queryKey: KEY,
    queryFn: () => request<Listing>('/client/payments'),
    refetchInterval: live,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    // Зачисление меняет остаток, а он стоит в шапке и на этой же странице.
    void queryClient.invalidateQueries({ queryKey: ['my', 'account'] });
  };

  const create = useMutation({
    mutationFn: () =>
      request<{ payment: Payment }>('/client/payments', {
        method: 'POST',
        body: { amount: numberFromInput(amount), comment },
      }),
    onSuccess: (body) => {
      setCreated(body.payment);
      setAmount('');
      setComment('');
      refresh();
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/client/payments/${id}/cancel`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (list.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {list.error.message}
      </p>
    );
  }
  if (list.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;

  const { instructions, payments } = list.data;
  const typed = numberFromInput(amount);
  const valid = moneyFromInput(amount) !== undefined && Number(typed) > 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Пополнение счёта</h2>
        {instructions !== '' && (
          <FormDialog
            label="Пополнить"
            title="Заявка на пополнение"
            description="Деньги появятся на счёте, когда администратор подтвердит перевод."
            onOpenChange={(open) => {
              if (open) setCreated(undefined);
            }}
          >
            <DialogForm
              submitLabel={valid ? `Создать заявку на ${money(typed)}` : 'Создать заявку'}
              canSubmit={valid}
              onSubmit={() => create.mutateAsync()}
            >
              <DialogField label="Сумма, ₽">
                <Input
                  className="num"
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus
                  placeholder="1 500,00"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </DialogField>
              <DialogField label="Пометка (необязательно)" wide>
                <Input
                  autoComplete="off"
                  placeholder="Номер платёжки, за что"
                  maxLength={300}
                  value={comment}
                  onChange={(event) => {
                    setComment(event.target.value);
                  }}
                />
              </DialogField>
            </DialogForm>
          </FormDialog>
        )}
      </div>

      {instructions === '' && (
        <p className="text-muted-foreground">
          Пополнение пока не настроено — обратитесь в поддержку.
        </p>
      )}

      {created !== undefined && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
          <p className="text-ok">
            Заявка на <b className="num">{money(created.amount)}</b> создана.
          </p>
          <p>Переведите деньги по реквизитам и укажите в переводе номер заявки:</p>
          <p className="num font-semibold">{numberOf(created.id)}</p>
          <p className="whitespace-pre-wrap break-words text-muted-foreground">{instructions}</p>
        </div>
      )}

      {payments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="num text-muted-foreground">{moment(payment.created_at)}</span>
              <span className="num w-[110px] font-semibold">{money(payment.amount)}</span>
              <span className={`rounded-md px-2 py-0.5 ${PAYMENT_STATUS_TONE[payment.status]}`}>
                {PAYMENT_STATUS_NAME[payment.status]}
              </span>
              <span className="num text-muted-foreground">№ {numberOf(payment.id)}</span>
              {payment.status === 'succeeded' && payment.received_amount !== null && (
                <span>зачислено {money(payment.received_amount)}</span>
              )}
              {payment.resolution_note !== null && (
                <span className="text-muted-foreground">{payment.resolution_note}</span>
              )}
              {payment.status === 'pending' && (
                <span className="ml-auto">
                  <ConfirmAction
                    label="Отозвать"
                    size="xs"
                    tone="neutral"
                    title={`Отозвать заявку № ${numberOf(payment.id)}`}
                    consequence={
                      <p>
                        Заявка закроется. Если вы уже перевели деньги — не отзывайте: напишите в
                        поддержку.
                      </p>
                    }
                    confirmLabel="Отозвать заявку"
                    onConfirm={() => cancel.mutateAsync(payment.id)}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
