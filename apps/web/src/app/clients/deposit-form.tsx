'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { isNegative, money, moneyFromInput, numberFromInput } from '@/lib/money';
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

/** Сумма, которую имеет смысл отправлять: денежная сумма больше нуля. */
function isAmount(value: string): boolean {
  const parsed = moneyFromInput(value);
  return parsed !== undefined && !/^0+(\.0*)?$/u.test(parsed);
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Ручное пополнение счёта клиента.
 *
 * Через подтверждение, которое повторяет сумму, клиента и основание: отменить пополнение
 * нельзя, а лишний разряд в сумме раньше уходил на счёт с первого нажатия
 * (ui-review, 2026-09-14). Открытие окна ключ идемпотентности не меняет — это то же
 * намерение.
 */
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
    onSuccess: (posted) => {
      setDone(posted);
      setAmount('');
      setDescription('');
      setKey(newKey());
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      // И лента проводок той же карточки: у неё свой ключ, и пополнение в ней не появлялось.
      void queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const fundsError = asApiError(funds.error);
  const typed = numberFromInput(amount);
  const amountValid = isAmount(typed);
  const ready = amountValid && description.trim() !== '';
  const shown = amountValid ? money(typed) : '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <Figure title="Остаток" value={funds.data?.balance} failed={fundsError} highlight />
        <Figure title="Придержано под вызовы" value={funds.data?.held} failed={fundsError} />
        <Figure title="Разрешённый минус" value={funds.data?.overdraft_limit} failed={fundsError} />
        <Figure
          title="Можно потратить сейчас"
          value={funds.data?.available}
          failed={fundsError}
          highlight
        />
      </div>
      {fundsError !== undefined && <ErrorNote error={fundsError} />}

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
              autoComplete="off"
              placeholder="1 500,00"
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
              autoComplete="off"
              placeholder="Платёжное поручение № 42 от 07.09.2026"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setKey(newKey());
                setDone(undefined);
              }}
            />
          </label>

          <ConfirmAction
            label="Пополнить"
            variant="default"
            size="default"
            tone="neutral"
            disabled={!ready}
            title={`Пополнить счёт «${client.name}»`}
            consequence={
              <>
                <p>
                  На остаток клиента сразу поступит <b className="num">{shown}</b>, и деньги станут
                  доступны для звонков.
                </p>
                <p>Основание: {description}</p>
                <p>
                  Отменить пополнение нельзя — только провести обратную операцию. Действие попадёт в
                  журнал вместе с суммой и вашим именем.
                </p>
              </>
            }
            confirmLabel={`Пополнить на ${shown}`}
            onConfirm={() => deposit.mutateAsync()}
          />
        </div>

        {amount !== '' && !amountValid && (
          <p className="pt-2 text-warn">
            Сумма — число больше нуля, не больше шести знаков после запятой: например 1 500,50.
          </p>
        )}

        <div aria-live="polite">
          {done !== undefined && (
            <p className={done.already_posted ? 'pt-2 text-warn' : 'pt-2 text-ok'}>
              {done.already_posted
                ? `Точно такая операция уже проводилась — повторно деньги не добавлены. Остаток: ${money(done.balance)}.`
                : `Проведено. Остаток: ${money(done.balance)}.`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Figure({
  title,
  value,
  failed,
  highlight,
}: {
  title: string;
  value: string | undefined;
  failed: ApiError | undefined;
  highlight?: boolean;
}) {
  // Отказ — не «загрузка»: вечное «…» при упавшем запросе читалось как «ещё считаем».
  const text = value === undefined ? (failed === undefined ? '…' : '—') : money(value);
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
        {text}
      </div>
    </div>
  );
}
