'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAYMENT_STATUSES, type PaymentStatus } from '@zvonix/shared';
import { Check, X } from 'lucide-react';
import { Suspense, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { LiveSwitch } from '@/components/live-switch';
import { Segmented } from '@/components/segmented';
import { HintText, StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
import { request } from '@/lib/api';
import { useClients } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { PAYMENT_STATUS_NAME, PAYMENT_STATUS_TONE } from '@/lib/labels';
import { useLiveInterval } from '@/lib/live';
import { MoneyTotal } from '@/components/money-total';
import { money, moneyFromInput, moneyInText, moneyTotal, numberFromInput } from '@/lib/money';

interface Payment {
  readonly id: string;
  readonly client_id: string;
  readonly status: PaymentStatus;
  readonly amount: string;
  readonly received_amount: string | null;
  readonly comment: string | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
}

const COLUMNS = 6;

/** Отбор: заявки, ждущие решения, — по умолчанию; остальное — для разбора. */
const FILTERS: readonly { value: PaymentStatus | ''; label: string }[] = [
  { value: 'pending', label: PAYMENT_STATUS_NAME.pending },
  ...PAYMENT_STATUSES.filter((status) => status !== 'pending').map((status) => ({
    value: status,
    label: PAYMENT_STATUS_NAME[status],
  })),
  { value: '', label: 'Все' },
];

export default function PaymentsPage() {
  return (
    <ConsoleShell title="Платежи" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <Payments />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function Payments() {
  const [status, setStatus] = useState<PaymentStatus | ''>('pending');
  const clients = useClients();
  const live = useLiveInterval();
  const canChange = useCanChange();

  const list = useQuery({
    queryKey: ['payments', status],
    refetchInterval: live,
    queryFn: () =>
      request<{ payments: Payment[]; total: number }>(
        `/payments?limit=200${status === '' ? '' : `&status=${status}`}`,
      ),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Какие заявки"
          options={FILTERS.map((filter) => ({ key: filter.value, label: filter.label }))}
          value={status}
          onChange={setStatus}
        />
        <div className="ml-auto">
          <LiveSwitch />
        </div>
      </div>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Когда</TableHead>
              <TableHead className={HEAD}>Клиент</TableHead>
              <TableHead className={`${HEAD} text-right`}>Сумма</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Пометка</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
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
            {list.data?.payments.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  {status === 'pending' ? 'Заявок, ждущих решения, нет.' : 'Заявок нет.'}
                </TableCell>
              </TableRow>
            )}
            {list.data?.payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell className={`num text-muted-foreground ${WIDE_ONLY}`}>
                  {moment(payment.created_at)}
                </TableCell>
                <TableCell>{clients.nameOf(payment.client_id) ?? '…'}</TableCell>
                {/*
                  Строка в одну линию (DESIGN.md, «Таблица»): зачисленное иначе — в подсказке у суммы, номер заявки —
                  у пометки, решение — у состояния.
                */}
                <TableCell className={`${NUM} font-semibold`}>
                  {payment.received_amount !== null &&
                  payment.received_amount !== payment.amount ? (
                    <HintText
                      label={moneyTotal(payment.amount)}
                      reason={`Заявка на ${moneyInText(payment.amount)}, зачислено ${moneyInText(payment.received_amount)}`}
                    />
                  ) : (
                    <MoneyTotal value={payment.amount} />
                  )}
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <span
                    className="block max-w-[280px] truncate"
                    title={`№ ${payment.id.slice(0, 8)}${payment.comment === null ? '' : `. ${payment.comment}`}`}
                  >
                    {payment.comment ?? (
                      <span className="num text-faint">№ {payment.id.slice(0, 8)}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusDot
                    tone={toneOf(PAYMENT_STATUS_TONE[payment.status])}
                    label={PAYMENT_STATUS_NAME[payment.status]}
                    reason={payment.resolution_note ?? undefined}
                  />
                </TableCell>
                <TableCell>
                  {canChange && payment.status === 'pending' && (
                    <RowActions>
                      <ConfirmPayment
                        payment={payment}
                        clientName={clients.nameOf(payment.client_id)}
                      />
                      <RejectPayment payment={payment} />
                    </RowActions>
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

function useRefresh(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    // Зачисление меняет остаток клиента и ленту его проводок.
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
    void queryClient.invalidateQueries({ queryKey: ['entries'] });
  };
}

/**
 * «Подтвердить»: деньги пришли. Сумма — та, что просил клиент, но правится: перевели иначе —
 * зачисляется то, что пришло. Зачисление необратимо, поэтому кнопка повторяет сумму.
 */
function ConfirmPayment({
  payment,
  clientName,
}: {
  payment: Payment;
  clientName: string | undefined;
}) {
  const refresh = useRefresh();
  const [amount, setAmount] = useState(payment.amount);

  const confirm = useMutation({
    mutationFn: () =>
      request<unknown>(`/payments/${payment.id}/confirm`, {
        method: 'POST',
        body: { amount: numberFromInput(amount) },
      }),
    onSuccess: refresh,
  });

  const typed = numberFromInput(amount);
  const valid = moneyFromInput(amount) !== undefined && Number(typed) > 0;

  return (
    <FormDialog
      label={<Check aria-hidden className="size-4" />}
      tooltip="Подтвердить"
      {...ROW_ICON}
      title={`Зачислить на счёт «${clientName ?? 'клиента'}»`}
      description="Деньги появятся на остатке сразу. Отменить зачисление нельзя — только обратная операция."
      onOpenChange={(open) => {
        if (open) setAmount(payment.amount);
      }}
    >
      <DialogForm
        submitLabel={valid ? `Зачислить ${money(typed)}` : 'Зачислить'}
        canSubmit={valid}
        onSubmit={() => confirm.mutateAsync()}
      >
        <DialogField label="Сколько пришло, ₽">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </DialogField>
        <p className="text-muted-foreground sm:col-span-2">
          Клиент просил {moneyInText(payment.amount)}. Если перевод пришёл на другую сумму, впишите
          ту, что пришла на самом деле. Действие попадёт в журнал вместе с вашим именем.
        </p>
      </DialogForm>
    </FormDialog>
  );
}

function RejectPayment({ payment }: { payment: Payment }) {
  const refresh = useRefresh();
  const [reason, setReason] = useState('');

  const reject = useMutation({
    mutationFn: () =>
      request<unknown>(`/payments/${payment.id}/reject`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: refresh,
  });

  return (
    <FormDialog
      label={<X aria-hidden className="size-4" />}
      tooltip="Отклонить"
      {...ROW_ICON}
      title={`Отклонить заявку на ${moneyInText(payment.amount)}`}
      description="Деньги не зачисляются. Причину увидит клиент."
      onOpenChange={(open) => {
        if (open) setReason('');
      }}
    >
      <DialogForm
        submitLabel="Отклонить заявку"
        canSubmit={reason.trim().length >= 3}
        onSubmit={() => reject.mutateAsync()}
      >
        <DialogField label="Причина" wide>
          <Input
            autoComplete="off"
            autoFocus
            maxLength={300}
            placeholder="Перевод не поступил"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}
