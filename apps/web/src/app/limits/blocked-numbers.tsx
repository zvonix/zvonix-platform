'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { ReadOnly } from '@/components/read-only';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { useCanChange } from '@/lib/access';
import { moment } from '@/lib/format';

const COLUMNS = 4;

interface Rule {
  readonly id: string;
  readonly prefix: string;
  readonly note: string;
  readonly created_at: string;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Чёрный список номеров ([ADR-0024](../../../../../docs/adr/0024-chyornyy-spisok-nomerov.md)).
 *
 * Правило — это префикс; точный номер есть префикс длиной одиннадцать. Проверяется
 * **до** определения оператора: тратить на запрещённый номер бюджет внешнего запроса
 * незачем, и сообщать этот номер стороннему источнику — тоже.
 *
 * До этого экрана запрет заводился только через `curl`. Запрет платного диапазона —
 * действие срочное: пока он не поставлен, деньги уходят в реальном времени.
 *
 * Снятие запрета — через общее окно подтверждения, как и остальные опасные действия
 * кабинета. Здесь раньше жил свой двухшаговый вариант: последствие он называл, но фокус
 * после первого нажатия терялся, а Escape не отменял.
 */
export function BlockedNumbers() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [note, setNote] = useState('');

  const list = useQuery({
    queryKey: ['blocked-numbers'],
    queryFn: () => request<{ rules: Rule[] }>('/blocked-numbers'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['blocked-numbers'] });
  };

  const block = useMutation({
    mutationFn: (input: { prefix: string; note: string }) =>
      request<{ rule: Rule }>('/blocked-numbers', { method: 'POST', body: input }),
    onSuccess: async () => {
      setPrefix('');
      setNote('');
      await refresh();
    },
  });

  const unblock = useMutation({
    mutationFn: (id: string) =>
      request<{ rule: Rule }>(`/blocked-numbers/${id}`, { method: 'DELETE' }),
    onSuccess: () => atMost(refresh()),
  });

  const trimmedPrefix = prefix.trim();
  const trimmedNote = note.trim();
  const ready = trimmedPrefix !== '' && trimmedNote.length >= 3;
  const failed = asApiError(block.error ?? list.error);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold tracking-tight">Чёрный список номеров</h2>
      <p className="text-muted-foreground">
        Правило — префикс: точный номер есть префикс длиной одиннадцать. Пишется так, как его видит
        человек — <span className="num">8-809</span> приводится к <span className="num">7809</span>.
        Проверяется раньше определения оператора, поэтому запрещённый номер не уходит во внешний
        источник.
      </p>

      {failed !== undefined && <ErrorNote error={failed} />}

      {canChange ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) block.mutate({ prefix: trimmedPrefix, note: trimmedNote });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Префикс</span>
            <Input
              className="num w-[140px]"
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              placeholder="8-809"
              value={prefix}
              onChange={(event) => {
                setPrefix(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Почему запрещено</span>
            <Input
              className="w-[360px]"
              autoComplete="off"
              placeholder="Платный диапазон"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || block.isPending}>
            {block.isPending ? 'Запрещаем…' : 'Запретить'}
          </Button>

          {trimmedPrefix !== '' && trimmedNote.length < 3 && (
            <p className="w-full text-warn">
              Назовите основание — не короче трёх знаков: по нему запрет потом снимают или
              оставляют.
            </p>
          )}
        </form>
      ) : (
        <ReadOnly what="запреты" />
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Префикс</TableHead>
              <TableHead className="h-8">Почему</TableHead>
              <TableHead className="h-8">Заведён</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.rules.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Список пуст — значит, не запрещено ничего. Короткие и экстренные номера сюда
                  вносить не нужно: они не проходят разбор номера и до чёрного списка не доходят. А
                  платные диапазоны проходят.
                </TableCell>
              </TableRow>
            )}

            {list.data?.rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="num">{rule.prefix}</TableCell>
                <TableCell className="whitespace-normal">{rule.note}</TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(rule.created_at)}</span>
                </TableCell>
                <TableCell>
                  {canChange && (
                    <ConfirmAction
                      label="Снять запрет"
                      title={`Снять запрет на ${rule.prefix}`}
                      consequence={
                        <>
                          <p>
                            Вызовы на номера, начинающиеся с{' '}
                            <span className="num">{rule.prefix}</span>, снова пойдут — и за них
                            снова будут списываться деньги.
                          </p>
                          <p>Основание запрета: {rule.note}</p>
                        </>
                      }
                      confirmLabel="Снять запрет"
                      onConfirm={() => unblock.mutateAsync(rule.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
