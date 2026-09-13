'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { useCanChange } from '@/lib/access';
import { moment } from '@/lib/format';

const COLUMNS = 4;

interface Rule {
  readonly id: string;
  readonly prefix: string;
  readonly note: string;
  readonly created_at: string;
}

/**
 * Чёрный список номеров ([ADR-0024](../../../../../docs/adr/0024-chyornyy-spisok-nomerov.md)).
 *
 * Правило — это префикс; точный номер есть префикс длиной одиннадцать. Проверяется
 * **до** определения оператора: тратить на запрещённый номер бюджет внешнего запроса
 * незачем, и сообщать этот номер стороннему источнику — тоже.
 *
 * До этого экрана запрет заводился только через `curl`. Запрет платного диапазона —
 * действие срочное: пока он не поставлен, деньги уходят в реальном времени.
 */
export function BlockedNumbers() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<string | undefined>(undefined);

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
    onSuccess: async () => {
      setRemoving(undefined);
      await refresh();
    },
  });

  const trimmedPrefix = prefix.trim();
  const trimmedNote = note.trim();
  const ready = trimmedPrefix !== '' && trimmedNote.length >= 3;
  const failed = [block.error, unblock.error, list.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold tracking-tight">Чёрный список номеров</h2>
      <p className="text-muted-foreground">
        Правило — префикс: точный номер есть префикс длиной одиннадцать. Пишется так, как его видит
        человек — <span className="num">8-809</span> приводится к <span className="num">7809</span>.
        Проверяется раньше определения оператора, поэтому запрещённый номер не уходит во внешний
        источник.
      </p>

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

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
              placeholder="Платный диапазон"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || block.isPending}>
            Запретить
          </Button>
        </form>
      ) : (
        <ReadOnly what="запреты" />
      )}

      <div className="rounded-lg border border-border bg-card">
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
                  {canChange &&
                    (removing === rule.id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground">
                          Снять запрет — вызовы на <span className="num">{rule.prefix}</span> пойдут
                          снова.
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={unblock.isPending}
                          onClick={() => {
                            unblock.mutate(rule.id);
                          }}
                        >
                          Снять
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRemoving(undefined);
                          }}
                        >
                          Отмена
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRemoving(rule.id);
                        }}
                      >
                        Снять запрет
                      </Button>
                    ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
