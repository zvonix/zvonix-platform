'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { isNegative, money, numberFromInput } from '@/lib/money';
import type { ClientRow } from './page';

interface Funds {
  readonly balance: string;
  readonly overdraft_limit: string;
  readonly held: string;
  readonly available: string;
}

interface Posted {
  readonly transaction_id: string;
  readonly already_posted: boolean;
  readonly balance: string;
}

/**
 * Ключ идемпотентности пополнения.
 *
 * Опознаёт **это конкретное намерение**, а не форму. Повторное нажатие «Пополнить» —
 * по двойному клику, по нетерпению, по возврату браузера — уходит с тем же ключом,
 * и денег не добавится.
 *
 * Но правка суммы или основания — это уже **другое** намерение, и ключ там берётся
 * новый. Иначе исправленная после опечатки сумма ушла бы под старым ключом, площадка
 * ответила бы «уже проведено» прежней суммой, и оператор решил бы, что его правку
 * отклонили как повтор. Сама площадка сверяет только ключ: для повторно доставленного
 * CDR это верно, а различать намерения — дело того, кто их формирует.
 */
function newKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function DepositForm({ client }: { client: ClientRow }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState(newKey);
  const [done, setDone] = useState<Posted | undefined>(undefined);

  /**
   * Сколько клиент может потратить **прямо сейчас**.
   *
   * Остаток на этот вопрос не отвечает: часть денег придержана под идущие вызовы.
   * Разбор «почему клиент не звонит, деньги же есть» начинается именно отсюда.
   */
  const funds = useQuery({
    queryKey: ['clients', client.id, 'funds'],
    queryFn: () => request<Funds>(`/clients/${client.id}/funds`),
  });

  const deposit = useMutation({
    mutationFn: () =>
      request<Posted>(`/clients/${client.id}/deposit`, {
        method: 'POST',
        body: { amount: numberFromInput(amount), idempotencyKey: key, description },
      }),
    onSuccess: async (posted) => {
      setDone(posted);
      setAmount('');
      setDescription('');
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const error = deposit.error instanceof ApiError ? deposit.error : undefined;
  const ready = amount.trim() !== '' && description.trim() !== '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <Figure title="Остаток" value={funds.data?.balance} highlight />
        <Figure title="Придержано под вызовы" value={funds.data?.held} />
        <Figure title="Разрешённый минус" value={funds.data?.overdraft_limit} />
        <Figure title="Можно потратить сейчас" value={funds.data?.available} highlight />
      </div>

      <div className="max-w-[720px] rounded-md border border-border bg-card p-3">
        <h3 className="pb-1 font-semibold">Пополнить вручную</h3>
        <p className="pb-2 text-muted-foreground">
          Деньги появятся на остатке сразу и станут доступны для звонков. Отменить пополнение нельзя
          — только провести обратную операцию. Действие попадает в журнал вместе с суммой и вашим
          именем.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Сумма, ₽</span>
            <Input
              className="num w-[140px]"
              inputMode="decimal"
              placeholder="1500.00"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setKey(newKey());
                setDone(undefined);
              }}
            />
          </label>

          <label className="flex flex-1 flex-col gap-1">
            <span className="text-muted-foreground">Основание</span>
            <Input
              placeholder="Платёжное поручение № 42 от 07.09.2026"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setKey(newKey());
                setDone(undefined);
              }}
            />
          </label>

          <Button
            type="button"
            disabled={!ready || deposit.isPending}
            onClick={() => {
              deposit.mutate();
            }}
          >
            {deposit.isPending ? 'Проводим…' : 'Пополнить'}
          </Button>
        </div>

        {done !== undefined && (
          <p className={done.already_posted ? 'pt-2 text-warn' : 'pt-2 text-ok'}>
            {done.already_posted
              ? `Точно такая операция уже проводилась — повторно деньги не добавлены. Остаток: ${money(done.balance)}.`
              : `Проведено. Остаток: ${money(done.balance)}.`}
          </p>
        )}

        {error !== undefined && <ErrorNote error={error} className="pt-2" />}
      </div>
    </div>
  );
}

function Figure({
  title,
  value,
  highlight,
}: {
  title: string;
  value: string | undefined;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{title}</div>
      <div
        className={
          highlight
            ? `num text-[15px] font-semibold ${value !== undefined && isNegative(value) ? 'text-warn' : ''}`
            : 'num text-[15px] text-muted-foreground'
        }
      >
        {value === undefined ? '…' : money(value)}
      </div>
    </div>
  );
}
