'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
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
import { useCanChange } from '@/lib/access';
import { request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { useStaffOperators, type Operator } from './operators';

/**
 * Справочник операторов с подтверждением записей импорта
 * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
 *
 * Импорт плана нумерации заводит оператора неподтверждённым: файл не говорит,
 * виртуальный он или нет, а ошибка в этом — деньги партнёра (ADR-0035). По такому
 * оператору не звонят, и цену на него партнёр не назначит. Подтверждённые идут
 * в конце списка: работа здесь — с теми, что ещё не смотрели.
 */
export function OperatorList() {
  const canChange = useCanChange();
  const operators = useStaffOperators();
  const [search, setSearch] = useState('');

  const rows = [...(operators.data ?? [])]
    .filter((operator) =>
      operator.name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')),
    )
    .sort(
      (a, b) =>
        Number(a.verified_at !== null) - Number(b.verified_at !== null) ||
        a.name.localeCompare(b.name, 'ru'),
    );
  const unverified = (operators.data ?? []).filter((row) => row.verified_at === null).length;
  const hosts = (operators.data ?? []).filter((row) => row.verified_at !== null && !row.is_mvno);

  return (
    <section aria-labelledby="operator-list" className="flex flex-col gap-3">
      <h2 id="operator-list" className="font-semibold">
        Справочник операторов
      </h2>
      <p className="max-w-prose text-muted-foreground">
        Операторов заводит план нумерации. Пока запись не подтверждена, по оператору не звонят и
        цену на него партнёр не назначит.
        {unverified > 0 && ` Не подтверждено: ${String(unverified)}.`}
      </p>
      {!canChange && <ReadOnly what="справочник операторов" />}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="operator-search">Найти</Label>
        <Input
          id="operator-search"
          className="w-[260px]"
          autoComplete="off"
          placeholder="МТС, Т2, Билайн…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>

      {operators.isPending ? (
        <p className="text-muted-foreground">Загружаем…</p>
      ) : operators.isError ? (
        <p role="alert" className="text-crit">
          {operators.error.message}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8">Оператор</TableHead>
                <TableHead className="h-8">Сеть</TableHead>
                <TableHead className="h-8">MNC</TableHead>
                <TableHead className="h-8">Запись</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="text-muted-foreground">
                    Ничего не нашлось.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((operator) => (
                <TableRow key={operator.id}>
                  <TableCell>{operator.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {operator.verified_at === null
                      ? '—'
                      : operator.is_mvno
                        ? `виртуальный, сеть ${hostName(operator, operators.data)}`
                        : 'своя'}
                  </TableCell>
                  <TableCell className="num">{operator.mnc ?? '—'}</TableCell>
                  <TableCell>
                    {operator.verified_at !== null ? (
                      'подтверждена'
                    ) : canChange ? (
                      <VerifyOperator operator={operator} hosts={hosts} />
                    ) : (
                      <span className="text-warn">не подтверждена</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function hostName(operator: Operator, all: readonly Operator[]): string {
  return all.find((row) => row.id === operator.host_operator_id)?.name ?? '—';
}

/** Подтверждение записи: своя у оператора сеть или он виртуальный на чужой. */
function VerifyOperator({ operator, hosts }: { operator: Operator; hosts: readonly Operator[] }) {
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: (input: { isMvno: boolean; hostOperatorId: string | null; mnc: string | null }) =>
      request<unknown>(`/operators/${operator.id}/verify`, { method: 'POST', body: input }),
    // Под общим ключом: и справочник этой страницы, и выбор оператора в формах.
    onSuccess: () => atMost(queryClient.invalidateQueries({ queryKey: ['operators'] })),
  });

  return (
    <FormDialog
      label="Подтвердить"
      title={`Подтвердить «${operator.name}»`}
      description="Действие попадёт в журнал с вашим именем."
      variant="outline"
    >
      <VerifyForm
        operator={operator}
        hosts={hosts.filter((host) => host.id !== operator.id)}
        onVerify={(input) => verify.mutateAsync(input)}
      />
    </FormDialog>
  );
}

function VerifyForm({
  operator,
  hosts,
  onVerify,
}: {
  operator: Operator;
  hosts: readonly Operator[];
  onVerify: (input: {
    isMvno: boolean;
    hostOperatorId: string | null;
    mnc: string | null;
  }) => Promise<unknown>;
}) {
  const [isMvno, setIsMvno] = useState(false);
  const [hostOperatorId, setHostOperatorId] = useState('');
  const [mnc, setMnc] = useState(operator.mnc ?? '');
  const mncValue = mnc.trim();
  const mncValid = mncValue === '' || /^\d{2,3}$/u.test(mncValue);

  return (
    <DialogForm
      submitLabel="Подтвердить запись"
      canSubmit={mncValid && (!isMvno || hostOperatorId !== '')}
      onSubmit={() =>
        onVerify({
          isMvno,
          hostOperatorId: isMvno ? hostOperatorId : null,
          mnc: mncValue === '' ? null : mncValue,
        })
      }
    >
      <DialogField label="Сеть" wide>
        <select
          value={isMvno ? 'mvno' : 'own'}
          onChange={(event) => {
            setIsMvno(event.target.value === 'mvno');
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="own">Своя сеть</option>
          <option value="mvno">Виртуальный оператор на чужой сети</option>
        </select>
      </DialogField>

      {isMvno && (
        <DialogField label="Чья сеть" wide>
          <select
            value={hostOperatorId}
            onChange={(event) => {
              setHostOperatorId(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите оператора с подтверждённой своей сетью</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </DialogField>
      )}

      <DialogField label="MNC" hint="Код сети, необязательно">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={mnc}
          onChange={(event) => {
            setMnc(event.target.value);
          }}
        />
      </DialogField>
      {!mncValid && <p className="text-warn sm:col-span-2">MNC — две или три цифры.</p>}

      <p className="text-muted-foreground sm:col-span-2">
        Виртуальный оператор звонит через чужую сеть: его абоненту звонят с SIM хозяина сети.
        Отметить так по ошибке — значит отправить вызов в чужую сеть за счёт партнёра.
      </p>
    </DialogForm>
  );
}
