'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MESSAGE_MAX_LENGTH } from '@zvonix/shared';
import { useState, type ReactNode } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { MESSAGE_FAILURE_NAME, MESSAGE_STATUS_NAME, messageTone } from '@/lib/labels';
import { money } from '@/lib/money';

interface Message {
  readonly id: string;
  readonly to: string;
  readonly text: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly cost: string | null;
  readonly created_at: string;
}

const LIST_KEY = ['client', 'messages'] as const;
const PRICE_KEY = ['client', 'messages', 'price'] as const;

/**
 * Отправка сообщений MAX и журнал отправленного — общая часть кабинета клиента и кабинета партнёра
 * ([ADR-0071](../../../../docs/adr/0071-soobscheniya-max.md)): деньги списываются со счёта **клиентского**
 * кабинета по цене, как у всех. `between` — то, что стоит между формой и журналом (у клиента — SMPP).
 */
export function SendMessages({ between }: { between?: ReactNode }) {
  const queryClient = useQueryClient();
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [done, setDone] = useState<Message | undefined>(undefined);

  const price = useQuery({
    queryKey: PRICE_KEY,
    queryFn: ({ signal }) =>
      request<{ enabled: boolean; price: string | null }>('/client/messages/price', { signal }),
    refetchInterval: 60_000,
  });

  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) =>
      request<{ messages: Message[]; total: number }>('/client/messages?limit=50', { signal }),
    // Статусы меняются в минуты: журнал обновляется сам.
    refetchInterval: 10_000,
  });

  const send = useMutation({
    mutationFn: () =>
      request<{ message: Message }>('/client/messages', {
        method: 'POST',
        body: { to: to.trim(), text },
      }),
    onSuccess: async (sent) => {
      setDone(sent.message);
      setText('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: LIST_KEY }),
        queryClient.invalidateQueries({ queryKey: ['client', 'account'] }),
        queryClient.invalidateQueries({ queryKey: ['funds'] }),
      ]);
    },
  });

  const enabled = price.data?.enabled === true;
  const sendError = send.error instanceof ApiError ? send.error : undefined;
  const listError = list.error instanceof ApiError ? list.error : undefined;
  const ready = to.trim().length >= 5 && text.trim() !== '' && text.length <= MESSAGE_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-4">
      {price.data !== undefined && !enabled && (
        <p className="rounded-md border border-border bg-card p-3 text-muted-foreground">
          Сообщения MAX пока не подключены. Обратитесь в поддержку.
        </p>
      )}

      {enabled && (
        <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <p className="text-muted-foreground">
            {price.data?.price === null || price.data?.price === undefined
              ? 'Сейчас нет доступных аккаунтов для отправки — повторите позже.'
              : `Одно сообщение — ${money(price.data.price)}. Не доставленное из-за отсутствия MAX у получателя возвращается на счёт.`}
          </p>

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !send.isPending) send.mutate();
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="msg-to">Номер получателя</Label>
              <Input
                id="msg-to"
                className="num max-w-64"
                inputMode="tel"
                autoComplete="off"
                placeholder="+7 900 123-45-67"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="msg-text">Текст</Label>
              <textarea
                id="msg-text"
                rows={4}
                maxLength={MESSAGE_MAX_LENGTH}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2"
              />
              <span className="num text-muted-foreground">
                {String(text.length)} из {String(MESSAGE_MAX_LENGTH)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={!ready || send.isPending || price.data?.price === null}
              >
                {send.isPending ? 'Отправляем…' : 'Отправить'}
              </Button>
              {done !== undefined && (
                <span role="status" className="text-ok">
                  Принято: {done.to}, списано {done.cost === null ? '—' : money(done.cost)}.
                </span>
              )}
            </div>
            {sendError !== undefined && <ErrorNote error={sendError} />}
          </form>
        </section>
      )}

      {between}

      {listError !== undefined && <ErrorNote error={listError} />}

      {enabled && (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8">Когда</TableHead>
                <TableHead className="h-8">Кому</TableHead>
                <TableHead className="h-8">Текст</TableHead>
                <TableHead className="h-8">Итог</TableHead>
                <TableHead className="h-8 text-right">Стоимость</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.messages.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="whitespace-normal text-muted-foreground">
                    Сообщений пока нет.
                  </TableCell>
                </TableRow>
              )}
              {list.data?.messages.map((message) => (
                <TableRow key={message.id}>
                  <TableCell>
                    <span className="num text-muted-foreground">{moment(message.created_at)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="num">{message.to}</span>
                  </TableCell>
                  <TableCell className="max-w-[320px] truncate" title={message.text}>
                    {message.text === '' ? (
                      <span className="text-faint">текст удалён по сроку хранения</span>
                    ) : (
                      message.text
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className={`rounded-md px-2 py-0.5 ${messageTone(message.status)}`}>
                      {MESSAGE_STATUS_NAME[message.status] ?? message.status}
                    </span>
                    {message.failure_reason !== null && (
                      <span className="block pt-0.5 text-muted-foreground">
                        {MESSAGE_FAILURE_NAME[message.failure_reason] ?? message.failure_reason};
                        деньги возвращены
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">
                    {message.cost === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      money(message.cost)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
