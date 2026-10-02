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
 * нажатие уходит с тем же ключом и денег не добавит, а правка суммы или основания — другое
 * намерение с новым ключом (так же устроено пополнение клиента, `clients/deposit-form`).
 */
const newKey = (): string => `web-${crypto.randomUUID()}`;

/**
 * Ручное пополнение партнёра: добавляет к тому, что ему причитается — премия, возмещение,
 * исправление ошибки. Отменить нельзя, поэтому кнопка подтверждения повторяет сумму.
 */
export function PartnerDeposit({ partnerId, name }: { partnerId: string; name: string }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState(newKey);
  const [done, setDone] = useState<Posted | undefined>(undefined);

  const deposit = useMutation({
    mutationFn: () =>
      request<Posted>(`/partners/${partnerId}/deposit`, {
        method: 'POST',
        body: { amount: numberFromInput(amount), idempotencyKey: key, description },
      }),
    onSuccess: (posted) => {
      setDone(posted);
      setAmount('');
      setDescription('');
      setKey(newKey());
      void queryClient.invalidateQueries({ queryKey: ['partners'] });
      void queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const typed = numberFromInput(amount);
  const valid = moneyFromInput(amount) !== undefined && Number(typed) > 0;
  const ready = valid && description.trim() !== '';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <FormDialog
        label="Пополнить"
        title={`Пополнить счёт партнёра «${name}»`}
        description="Сумма добавится к тому, что причитается партнёру."
        onOpenChange={(open) => {
          if (open) setDone(undefined);
        }}
      >
        <DialogForm
          submitLabel={valid ? `Пополнить на ${money(typed)}` : 'Пополнить'}
          canSubmit={ready}
          onSubmit={() => deposit.mutateAsync()}
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
              placeholder="Премия, возмещение, исправление"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
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
            Отменить пополнение нельзя — только провести обратную операцию. Действие попадёт в
            журнал вместе с суммой и вашим именем.
          </p>
        </DialogForm>
      </FormDialog>
      <div aria-live="polite">
        {done !== undefined && (
          <p className={done.already_posted ? 'text-warn' : 'text-ok'}>
            {done.already_posted
              ? `Точно такая операция уже проводилась — повторно деньги не добавлены. Причитается: ${money(done.balance)}.`
              : `Проведено. Причитается: ${money(done.balance)}.`}
          </p>
        )}
      </div>
    </div>
  );
}
