'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MESSAGE_MAX_LENGTH } from '@zvonix/shared';
import { Fragment, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import {
  JournalFilters,
  JournalPages,
  journalSearch,
  StageCells,
  stageColumns,
  StageHeads,
  useJournalFilter,
} from '@/components/message-journal';
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
import { loadAllRows } from '@/lib/csv';
import { moment } from '@/lib/format';
import { MESSAGE_STATUS_NAME } from '@/lib/labels';
import { money } from '@/lib/money';

interface Message {
  readonly id: string;
  readonly to: string;
  readonly text: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly cost: string | null;
  /** Как получил человек — с шаблоном и «СТОП» (ADR-0093); `null` — не ушло. */
  readonly full_text: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const LIST_KEY = ['client', 'messages'] as const;
const ROUTES_KEY = ['client', 'messages', 'route-stats'] as const;

interface RouteStats {
  readonly recipients: number;
  readonly in_bot: number;
  readonly via_bot: number;
  readonly via_accounts: number;
}
const PRICE_KEY = ['client', 'messages', 'price'] as const;

/**
 * Отправка сообщений MAX и журнал отправленного — общая часть кабинета клиента и кабинета партнёра
 * ([ADR-0071](../../../../docs/adr/0071-soobscheniya-max.md)): деньги списываются со счёта **клиентского**
 * кабинета по цене, как у всех.
 */
export function SendMessages() {
  const routes = useQuery({
    queryKey: ROUTES_KEY,
    queryFn: ({ signal }) => request<RouteStats>('/client/messages/route-stats?days=7', { signal }),
    refetchInterval: 60_000,
  });
  const [opened, setOpened] = useState<string | undefined>(undefined);
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

  const [filter, changeFilter] = useJournalFilter();
  const search = journalSearch(filter);
  const list = useQuery({
    queryKey: [...LIST_KEY, search.toString()],
    queryFn: ({ signal }) =>
      request<{ messages: Message[]; total: number }>(`/client/messages?${search.toString()}`, {
        signal,
      }),
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

      {listError !== undefined && <ErrorNote error={listError} />}

      {enabled && routes.data !== undefined && routes.data.recipients > 0 && (
        // Бот или аккаунты за неделю (ADR-0094): видно, сколько людей уже перешли в бота.
        <p className="text-muted-foreground">
          За 7 суток: людей {String(routes.data.recipients)}, из них в боте{' '}
          {String(routes.data.in_bot)} (
          {String(Math.round((routes.data.in_bot * 100) / routes.data.recipients))} %); сообщений
          через бота {String(routes.data.via_bot)}, через аккаунты партнёров{' '}
          {String(routes.data.via_accounts)}.
        </p>
      )}
      {enabled && (
        <JournalFilters
          filter={filter}
          onChange={changeFilter}
          exportName="сообщения-max"
          load={async () => {
            const filters = journalSearch(filter);
            filters.delete('offset');
            const found = await loadAllRows<Message>('/client/messages', filters, 'messages');
            return {
              header: [
                'Принято',
                'Кому',
                'Текст',
                'Ушло',
                'Доставлено',
                'Прочитано',
                'Итог',
                'Стоимость, ₽',
              ],
              rows: found.rows.map((message) => [
                moment(message.created_at),
                message.to,
                message.text,
                ...stageColumns(message),
                MESSAGE_STATUS_NAME[message.status] ?? message.status,
                message.cost ?? '',
              ]),
              truncated: found.truncated,
            };
          }}
        />
      )}
      {enabled && (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8">Принято</TableHead>
                <TableHead className="h-8">Кому</TableHead>
                <TableHead className="h-8">Текст</TableHead>
                <StageHeads />
                <TableHead className="h-8 text-right">Стоимость</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.messages.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="whitespace-normal text-muted-foreground">
                    {filter.status === '' && filter.from === '' && filter.to === ''
                      ? 'Сообщений пока нет.'
                      : 'По этому отбору сообщений нет.'}
                  </TableCell>
                </TableRow>
              )}
              {list.data?.messages.map((message) => (
                <Fragment key={message.id}>
                  <TableRow>
                    <TableCell>
                      <span className="num text-muted-foreground">
                        {moment(message.created_at)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="num">{message.to}</span>
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <span className="block truncate" title={message.text}>
                        {message.text === '' ? (
                          <span className="text-faint">текст удалён по сроку хранения</span>
                        ) : (
                          message.text
                        )}
                      </span>
                      {message.full_text !== null && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpened(message.id);
                          }}
                          className="text-sm text-primary underline-offset-2 hover:underline"
                        >
                          Полный текст
                        </button>
                      )}
                    </TableCell>
                    <StageCells message={message} refundNote />
                    <TableCell className="num text-right">
                      {message.cost === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        money(message.cost)
                      )}
                    </TableCell>
                  </TableRow>
                  {opened === message.id && message.full_text !== null && (
                    // Окном, а не строкой под сообщением: длинный текст раздвигал таблицу (владелец, 2026-10-22).
                    <FormDialog
                      open
                      onOpenChange={(open) => {
                        if (!open) setOpened(undefined);
                      }}
                      title="Так сообщение получил человек"
                      description={`${moment(message.created_at)} · ${message.to}`}
                    >
                      <div className="overflow-y-auto px-5 pb-5">
                        <p className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5">
                          {message.full_text}
                        </p>
                      </div>
                    </FormDialog>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {enabled && <JournalPages filter={filter} total={list.data?.total} onChange={changeFilter} />}
    </div>
  );
}
