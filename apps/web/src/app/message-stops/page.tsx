'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
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
import { moment } from '@/lib/format';

interface Stop {
  readonly id: string;
  readonly phone: string;
  readonly source: 'account' | 'bot';
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly created_at: string;
}

const SOURCE_NAME: Record<Stop['source'], string> = {
  account: 'ответ на аккаунт',
  bot: '«СТОП» боту',
};

const KEY = ['messenger', 'stops'] as const;

export default function MessageStopsPage() {
  return (
    <ConsoleShell title="Не писать" requireRole={['admin', 'support']}>
      {() => <StopsView />}
    </ConsoleShell>
  );
}

function StopsView() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const search = phone.trim();

  const list = useQuery({
    queryKey: [...KEY, search],
    queryFn: ({ signal }) =>
      request<{ stops: Stop[]; total: number }>(
        `/messages/stops?limit=100${search === '' ? '' : `&phone=${encodeURIComponent(search)}`}`,
        { signal },
      ),
  });

  const remove = useMutation({
    mutationFn: (id: string) => request<undefined>(`/messages/stops/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const error = list.error instanceof ApiError ? list.error : undefined;

  return (
    <div className="flex max-w-[1000px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          inputMode="tel"
          autoComplete="off"
          placeholder="Найти по номеру целиком"
          aria-label="Найти по номеру целиком"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
          }}
        />
        <Hint label="Что это за список">
          <p>
            Номера тех, кто ответил «СТОП». Номер скрыт, чтобы список не раскрывал чужие данные:
            чтобы найти человека, введите его номер целиком. Убрать запрет можно только по просьбе
            самого человека.
          </p>
        </Hint>
        {list.data !== undefined && (
          <span className="num text-muted-foreground">Всего: {String(list.data.total)}</span>
        )}
      </div>

      {error !== undefined && <ErrorNote error={error} />}
      {remove.error instanceof ApiError && <ErrorNote error={remove.error} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Номер</TableHead>
              <TableHead className="h-8">Откуда</TableHead>
              <TableHead className="h-8">Чьи сообщения</TableHead>
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.stops.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-muted-foreground">
                  {search === '' ? 'Пока никто не писал «СТОП».' : 'Такого номера в списке нет.'}
                </TableCell>
              </TableRow>
            )}
            {list.data?.stops.map((stop) => (
              <TableRow key={stop.id}>
                <TableCell className="num">{stop.phone}</TableCell>
                <TableCell>{SOURCE_NAME[stop.source]}</TableCell>
                <TableCell className="whitespace-normal">
                  {stop.client_id === null ? (
                    <span className="text-warn">все клиенты</span>
                  ) : (
                    (stop.client_name ?? 'клиент')
                  )}
                </TableCell>
                <TableCell className="num">{moment(stop.created_at)}</TableCell>
                <TableCell className="text-right">
                  {canChange && (
                    <ConfirmAction
                      label="Убрать"
                      title="Убрать запрет"
                      consequence={
                        <p>
                          Номеру снова смогут писать{' '}
                          {stop.client_id === null ? 'все клиенты' : 'этот клиент'}. Делайте это
                          только по просьбе самого человека. Действие останется в журнале.
                        </p>
                      }
                      confirmLabel="Убрать"
                      size="xs"
                      onConfirm={() => remove.mutateAsync(stop.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
