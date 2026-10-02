'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { money, moneyFromInput, numberFromInput } from '@/lib/money';

interface Posted {
  readonly transaction_id: string;
  readonly already_posted: boolean;
  readonly balance: string;
}

/**
 * Ключ идемпотентности: опознаёт **это конкретное намерение**, а не форму. Повторное
 * нажатие уходит с тем же ключом и денег не тронет, а правка суммы или основания — другое
 * намерение с новым ключом (так же устроено пополнение клиента, `clients/deposit-form`).
 */
const newKey = (): string => `web-${crypto.randomUUID()}`;

/**
 * Ручная денежная операция администратора: окно «сумма + основание» и итог под кнопкой.
 *
 * Общая для пополнения партнёра, выплаты партнёру и ручного списания у клиента и партнёра:
 * отличаются адресом, словами и тем, что показывается после проведения. Отменить такую
 * операцию нельзя, поэтому кнопка подтверждения повторяет сумму.
 */
export function MoneyOperation({
  path,
  label,
  title,
  description,
  reasonPlaceholder,
  balanceName,
  doneText,
  variant,
  invalidate,
}: {
  /** Адрес действия: `/partners/<id>/payout`. */
  path: string;
  /** Надпись на кнопке и на подтверждении: «Пополнить», «Выплатить», «Списать». */
  label: string;
  title: string;
  description: string;
  reasonPlaceholder: string;
  /** Как называется остаток в итоге: «Причитается», «Остаток». */
  balanceName: string;
  /** Начало итога: «Проведено», «Выплата записана». */
  doneText: string;
  variant?: 'outline';
  /** Корни запросов, которые устарели после операции. */
  invalidate: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [done, setDone] = useState<Posted | undefined>(undefined);

  const operation = useMutation({
    mutationFn: () =>
      request<Posted>(path, {
        method: 'POST',
        body: { amount: numberFromInput(amount), idempotencyKey: key, description: reason },
      }),
    onSuccess: (posted) => {
      setDone(posted);
      setAmount('');
      setReason('');
      setKey(newKey());
      for (const root of invalidate) void queryClient.invalidateQueries({ queryKey: [root] });
      void queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const typed = numberFromInput(amount);
  const valid = moneyFromInput(amount) !== undefined && Number(typed) > 0;
  const ready = valid && reason.trim() !== '';

  return (
    <div className="flex flex-col gap-1">
      <FormDialog
        label={label}
        title={title}
        description={description}
        {...(variant === undefined ? {} : { variant })}
        onOpenChange={(open) => {
          if (open) setDone(undefined);
        }}
      >
        <DialogForm
          submitLabel={valid ? `${label} ${money(typed)}` : label}
          canSubmit={ready}
          onSubmit={() => operation.mutateAsync()}
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
                setKey(newKey());
              }}
            />
          </DialogField>
          <DialogField label="Основание" wide>
            <Input
              autoComplete="off"
              placeholder={reasonPlaceholder}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setKey(newKey());
              }}
            />
          </DialogField>
          {amount !== '' && !valid && (
            <p className="text-warn sm:col-span-2">
              Сумма — число больше нуля, не больше шести знаков после запятой: например 1 500,50.
            </p>
          )}
          <p className="text-muted-foreground sm:col-span-2">
            Отменить операцию нельзя — только провести обратную. Действие попадёт в журнал вместе с
            суммой и вашим именем.
          </p>
        </DialogForm>
      </FormDialog>
      <div aria-live="polite">
        {done !== undefined && (
          <p className={done.already_posted ? 'text-warn' : 'text-ok'}>
            {done.already_posted
              ? `Точно такая операция уже проводилась — повторно деньги не тронуты. ${balanceName}: ${money(done.balance)}.`
              : `${doneText}. ${balanceName}: ${money(done.balance)}.`}
          </p>
        )}
      </div>
    </div>
  );
}
