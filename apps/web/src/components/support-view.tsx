'use client';

/**
 * Обращения в поддержку ([ADR-0085](../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 *
 * Один экран на три кабинета: клиент и партнёр видят свои обращения, сотрудники — очередь всех. Слева список, справа
 * переписка; на телефоне друг под другом. Состояние выбранного обращения — в адресе (`?id=`): ссылку из письма можно
 * открыть сразу на нужном.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TICKET_BODY_MAX,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
  type TicketCabinet,
  type TicketStatus,
} from '@zvonix/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Choice } from '@/components/choice';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { LiveSwitch } from '@/components/live-switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { TICKET_CATEGORY_NAME, TICKET_STATUS_NAME, TICKET_STATUS_TONE } from '@/lib/labels';
import { useLiveInterval } from '@/lib/live';

interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly category: keyof typeof TICKET_CATEGORY_NAME;
  readonly status: TicketStatus;
  readonly cabinet: TicketCabinet;
  readonly author_email: string;
  readonly assignee_user_id: string | null;
  readonly last_message_at: string;
  readonly created_at: string;
}

interface Message {
  readonly id: string;
  readonly side: 'user' | 'staff';
  readonly body: string;
  readonly internal: boolean;
  readonly created_at: string;
}

interface Detail {
  readonly ticket: Ticket;
  readonly messages: Message[];
}

const FIELD = 'rounded-md border border-input bg-transparent px-2.5 py-2';

/** Для автора — «Поддержка» и «Вы», для сотрудника — адрес автора. */
export function SupportView({
  mode,
  cabinet,
}: {
  mode: 'author' | 'staff';
  /** Кабинет, из которого пишет автор: попадает в обращение. */
  cabinet?: TicketCabinet;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('id');
  const live = useLiveInterval();
  const staff = mode === 'staff';
  const base = staff ? '/support/staff/tickets' : '/support/tickets';

  const [status, setStatus] = useState<string>('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['support', mode, status, category, search],
    refetchInterval: live,
    queryFn: () => {
      const query = new URLSearchParams({ limit: '200' });
      if (status !== '') query.set('status', status);
      if (staff && category !== '') query.set('category', category);
      if (staff && search.trim() !== '') query.set('q', search.trim());
      return request<{ tickets: Ticket[]; total: number }>(`${base}?${query.toString()}`);
    },
  });

  const select = (id: string | null): void => {
    router.replace(id === null ? '?' : `?id=${id}`, { scroll: false });
  };

  return (
    <div className="flex max-w-[1200px] flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Состояние"
          anyLabel={staff ? 'Все' : 'Все мои обращения'}
          value={status}
          options={TICKET_STATUSES.map((value) => [value, TICKET_STATUS_NAME[value]] as const)}
          onChange={setStatus}
        />
        {staff && (
          <>
            <Choice
              label="О чём"
              anyLabel="Любое"
              value={category}
              options={TICKET_CATEGORIES.map(
                (value) => [value, TICKET_CATEGORY_NAME[value]] as const,
              )}
              onChange={setCategory}
            />
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Поиск</span>
              <Input
                value={search}
                placeholder="тема или адрес"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          {staff && <LiveSwitch />}
          {!staff && cabinet !== undefined && <NewTicket cabinet={cabinet} onCreated={select} />}
        </div>
      </div>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(260px,360px)_1fr]">
        <ul className="flex flex-col gap-1.5" aria-label="Обращения">
          {list.isPending && <li className="text-muted-foreground">Загружаем…</li>}
          {list.data?.tickets.length === 0 && (
            <li className="rounded-lg border border-border bg-card p-3 text-muted-foreground">
              {staff
                ? 'Обращений нет.'
                : 'Обращений пока нет. Нашли ошибку или нужна функция — напишите нам.'}
            </li>
          )}
          {list.data?.tickets.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                aria-current={ticket.id === selected}
                onClick={() => {
                  select(ticket.id);
                }}
                className={`flex w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${
                  ticket.id === selected ? 'border-primary' : 'border-border'
                }`}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-medium">{ticket.subject}</span>
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 ${TICKET_STATUS_TONE[ticket.status]}`}
                  >
                    {TICKET_STATUS_NAME[ticket.status]}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {TICKET_CATEGORY_NAME[ticket.category]}
                  {staff && ` · ${ticket.author_email}`}
                </span>
                <span className="num text-faint">{moment(ticket.last_message_at)}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected === null ? (
          <p className="hidden rounded-lg border border-dashed border-border p-6 text-muted-foreground lg:block">
            Выберите обращение слева.
          </p>
        ) : (
          <Conversation key={selected} id={selected} mode={mode} />
        )}
      </div>
    </div>
  );
}

function useRefresh(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['support'] });
  };
}

/** «Новое обращение»: категория, тема, текст. После создания открывается его переписка. */
function NewTicket({
  cabinet,
  onCreated,
}: {
  cabinet: TicketCabinet;
  onCreated: (id: string) => void;
}) {
  const refresh = useRefresh();
  const [category, setCategory] = useState<string>('bug');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  return (
    <FormDialog label="Новое обращение" title="Новое обращение в поддержку" size="sm">
      <DialogForm
        submitLabel="Отправить"
        canSubmit={subject.trim().length >= 3 && body.trim().length >= 3}
        onSubmit={async () => {
          const created = await request<Detail>('/support/tickets', {
            method: 'POST',
            body: { cabinet, subject: subject.trim(), category, body: body.trim() },
          });
          setSubject('');
          setBody('');
          refresh();
          onCreated(created.ticket.id);
        }}
      >
        <DialogField label="О чём" wide>
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2"
          >
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TICKET_CATEGORY_NAME[value]}
              </option>
            ))}
          </select>
        </DialogField>
        <DialogField label="Тема" wide>
          <Input
            autoFocus
            maxLength={TICKET_SUBJECT_MAX}
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </DialogField>
        <DialogField label="Что случилось или что нужно" wide>
          <textarea
            rows={6}
            maxLength={TICKET_BODY_MAX}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            className={FIELD}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

function Conversation({ id, mode }: { id: string; mode: 'author' | 'staff' }) {
  const staff = mode === 'staff';
  const refresh = useRefresh();
  const live = useLiveInterval();
  const base = staff ? '/support/staff/tickets' : '/support/tickets';
  const detail = useQuery({
    queryKey: ['support', 'detail', mode, id],
    refetchInterval: live,
    queryFn: () => request<Detail>(`${base}/${id}`),
  });

  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const act = useMutation({
    mutationFn: (action: {
      path: string;
      method: 'POST' | 'PATCH';
      body?: Record<string, unknown>;
    }) =>
      request<Detail>(`${base}/${id}${action.path}`, {
        method: action.method,
        ...(action.body === undefined ? {} : { body: action.body }),
      }),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : 'Не получилось. Попробуйте ещё раз');
    },
  });

  if (detail.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  if (detail.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {detail.error.message}
      </p>
    );
  }
  const { ticket, messages } = detail.data;
  const closed = ticket.status === 'closed';

  const send = (): void => {
    if (text.trim().length < 3) return;
    act.mutate(
      {
        path: '/messages',
        method: 'POST',
        body: staff ? { body: text.trim(), internal } : { body: text.trim() },
      },
      {
        onSuccess: () => {
          setText('');
          setInternal(false);
        },
      },
    );
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      aria-label="Переписка"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col">
          <h2 className="font-semibold">{ticket.subject}</h2>
          <span className="text-muted-foreground">
            {TICKET_CATEGORY_NAME[ticket.category]}
            {staff &&
              ` · ${ticket.cabinet === 'client' ? 'клиент' : 'партнёр'} ${ticket.author_email}`}
          </span>
        </div>
        <span className={`rounded-md px-2 py-0.5 ${TICKET_STATUS_TONE[ticket.status]}`}>
          {TICKET_STATUS_NAME[ticket.status]}
        </span>
      </header>

      {staff && !closed && (
        <div className="flex flex-wrap items-end gap-2">
          <Choice
            label="Состояние"
            anyLabel={TICKET_STATUS_NAME[ticket.status]}
            value=""
            options={TICKET_STATUSES.filter((value) => value !== ticket.status).map(
              (value) => [value, TICKET_STATUS_NAME[value]] as const,
            )}
            onChange={(value) => {
              if (value !== '')
                act.mutate({ path: '/status', method: 'PATCH', body: { status: value } });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={act.isPending}
            onClick={() => {
              act.mutate({
                path: '/assignee',
                method: 'PATCH',
                body: { assignee: ticket.assignee_user_id === null ? 'me' : null },
              });
            }}
          >
            {ticket.assignee_user_id === null ? 'Взять себе' : 'Снять исполнителя'}
          </Button>
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {messages.map((message) => (
          <li
            key={message.id}
            className={`flex flex-col gap-0.5 rounded-md p-2.5 ${
              message.internal
                ? 'border border-warn bg-warn-soft'
                : message.side === 'staff'
                  ? 'bg-muted'
                  : 'border border-border'
            }`}
          >
            <span className="text-muted-foreground">
              {message.internal
                ? 'Заметка для своих — автору не видна'
                : message.side === 'staff'
                  ? 'Поддержка'
                  : staff
                    ? ticket.author_email
                    : 'Вы'}
              {' · '}
              <span className="num">{moment(message.created_at)}</span>
            </span>
            <span className="whitespace-pre-wrap break-words">{message.body}</span>
          </li>
        ))}
      </ol>

      {failure !== undefined && (
        <p role="alert" className="text-crit">
          {failure}
        </p>
      )}

      {closed && !staff ? (
        <p className="text-muted-foreground">
          Обращение закрыто. Если вопрос остался — создайте новое.
        </p>
      ) : closed ? (
        <p className="text-muted-foreground">Обращение закрыто, отвечать нельзя.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {staff ? 'Ответ или заметка' : 'Ваш ответ'}
            </span>
            <textarea
              rows={4}
              maxLength={TICKET_BODY_MAX}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={FIELD}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={act.isPending || text.trim().length < 3} onClick={send}>
              {staff && internal ? 'Добавить заметку' : 'Отправить'}
            </Button>
            {staff && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => {
                    setInternal(event.target.checked);
                  }}
                />
                Заметка для своих
              </label>
            )}
            {!staff && (
              <Button
                type="button"
                variant="outline"
                disabled={act.isPending}
                onClick={() => {
                  act.mutate({ path: '/close', method: 'POST' });
                }}
              >
                Решено — закрыть
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
