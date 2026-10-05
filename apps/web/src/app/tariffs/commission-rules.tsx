'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMISSION_MAX_BASIS_POINTS, type CommissionProduct } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
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
import { useClients } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { basisPointsFromPercent, microunits, money, moneyFromInput, percent } from '@/lib/money';

interface CommissionRule {
  readonly id: string;
  readonly client_id: string | null;
  readonly fixed_fee: string;
  readonly percent_basis_points: string;
  readonly effective_from: string;
}

/** Что называют слова страницы: вызовы и сообщения MAX наценяются одними и теми же правилами (ADR-0073). */
const TEXT = {
  call: {
    title: 'Наценка на звонки',
    unit: 'вызов',
    fee: 'Фикс за вызов',
    feeDialog: 'Фикс за вызов, ₽',
    noDefault:
      'Правила по умолчанию нет: клиент, у которого нет своего правила, не сможет позвонить — вызов отклонится с причиной «нет тарифа». Добавьте правило без клиента.',
    history: 'прошлые вызовы тарифицированы по тем, что действовали на момент разговора',
    sample: '10',
    sampleWhat: 'вызов обошёлся партнёру',
  },
  message: {
    title: 'Наценка на сообщения MAX',
    unit: 'сообщение',
    fee: 'Фикс за сообщение',
    feeDialog: 'Фикс за сообщение, ₽',
    noDefault:
      'Правила по умолчанию нет: сообщения уходят без наценки. Добавьте правило без клиента.',
    history: 'прошлые сообщения оценены по тем, что действовали на момент отправки',
    sample: '0.45',
    sampleWhat: 'партнёр берёт за сообщение',
  },
} as const;

/** Потолок доли в сотых процента — тот же, что проверяет API: выше — опечатка в разрядах. */
const maxBasisPoints = (product: CommissionProduct): number => COMMISSION_MAX_BASIS_POINTS[product];

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

type RuleState = 'current' | 'planned' | 'replaced';

interface RuleRow {
  readonly rule: CommissionRule;
  readonly state: RuleState;
}

/**
 * Состояние каждого правила: в каждой «области» (все клиенты или один клиент) действует самое свежее из уже
 * начавшихся, более свежие, но не начавшиеся, — «начнёт действовать», более старые — «заменено».
 */
function withStates(rules: readonly CommissionRule[], now: number): RuleRow[] {
  const scopes = new Map<string, CommissionRule[]>();
  for (const rule of rules) {
    const key = rule.client_id ?? '';
    scopes.set(key, [...(scopes.get(key) ?? []), rule]);
  }
  const rows: RuleRow[] = [];
  for (const group of scopes.values()) {
    const fresh = [...group].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
    const currentIndex = fresh.findIndex((rule) => Date.parse(rule.effective_from) <= now);
    fresh.forEach((rule, index) => {
      rows.push({
        rule,
        state: index < currentIndex ? 'planned' : index === currentIndex ? 'current' : 'replaced',
      });
    });
  }
  const order: Record<RuleState, number> = { current: 0, planned: 1, replaced: 2 };
  return rows.sort(
    (a, b) =>
      order[a.state] - order[b.state] ||
      Number(a.rule.client_id !== null) - Number(b.rule.client_id !== null) ||
      b.rule.effective_from.localeCompare(a.rule.effective_from),
  );
}

/** Дата начала: правило из миграции (2000 год) действует «с самого начала», а не с выдуманной даты. */
const since = (value: string): string =>
  Date.parse(value) < Date.UTC(2001, 0, 1) ? 'с начала' : moment(value);

/** Доля в процентах, как её набирают: `1250` → «12,5». */
const shareText = (basisPoints: string): string =>
  (Number(basisPoints) / 100).toString().replace('.', ',');

const STATE_VIEW: Record<RuleState, { readonly label: string; readonly className: string }> = {
  current: { label: 'Действует', className: 'text-ok' },
  planned: { label: 'Начнёт действовать', className: 'text-warn' },
  replaced: { label: 'Заменено', className: 'text-faint' },
};

/**
 * Наценка платформы.
 *
 * Без действующего правила маршрутизация отказывает с причиной `no_tariff` — то есть
 * **ни один вызов не тарифицируется**. Правило без клиента — умолчание платформы;
 * правило с клиентом перебивает его для этого клиента.
 *
 * Записи не стираются: «Изменить» заводит **новое** правило на место действующего, а прежнее остаётся в истории
 * со статусом «заменено». Звонок, тарифицированный вчера, не должен переоцениваться сегодняшней наценкой
 * ([ADR-0010](../../../../../docs/adr/0010-model-billinga.md)).
 *
 * Добавление — окном, а в нём через подтверждение, которое называет охват и долю: форма
 * заполнена заранее, и раньше одно нажатие заводило наценку 15 % на всю площадку. Доля
 * разбирается строкой: пустое поле больше не становится наценкой 0 %, а `0,285` — 28
 * сотыми вместо отказа (ui-review, 2026-09-14).
 */
export function CommissionRules({ product }: { product: CommissionProduct }) {
  const text = TEXT[product];
  const canChange = useCanChange();
  const clients = useClients();
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const list = useQuery({
    queryKey: ['commission-rules', product],
    queryFn: () => request<{ rules: CommissionRule[] }>(`/commission-rules?product=${product}`),
  });

  const listError = asApiError(list.error);
  const rules = list.data?.rules ?? [];
  const noDefault = list.data !== undefined && !rules.some((rule) => rule.client_id === null);
  const rows = withStates(rules, Date.now());
  const replaced = rows.filter((row) => row.state === 'replaced').length;
  const shown = showHistory ? rows : rows.filter((row) => row.state !== 'replaced');

  return (
    <section className="flex max-w-[960px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{text.title}</h2>
        {canChange && (
          <FormDialog
            label="Добавить правило"
            title="Новое правило наценки"
            description="Начинает действовать сразу или с выбранной даты; прежние правила остаются в истории."
            variant="outline"
            open={open}
            onOpenChange={setOpen}
          >
            <NewCommissionRule
              product={product}
              onAdded={() => {
                setOpen(false);
              }}
            />
          </FormDialog>
        )}
        {replaced > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            aria-pressed={showHistory}
            onClick={() => {
              setShowHistory((value) => !value);
            }}
          >
            {showHistory ? 'Скрыть историю' : `История изменений (${String(replaced)})`}
          </Button>
        )}
      </div>

      {noDefault && (
        <p className={product === 'call' ? 'text-crit' : 'text-warn'}>{text.noDefault}</p>
      )}

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">К кому относится</TableHead>
              <TableHead className="h-8 text-right">Доля</TableHead>
              <TableHead className="h-8 text-right">{text.fee}</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              {canChange && <TableHead className="h-8" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={canChange ? 6 : 5} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {shown.map(({ rule, state }) => (
              <TableRow key={rule.id} className={state === 'replaced' ? 'opacity-60' : undefined}>
                <TableCell>
                  {rule.client_id === null ? (
                    <span className="text-muted-foreground">все клиенты</span>
                  ) : (
                    (clients.nameOf(rule.client_id) ?? (
                      <span className="num text-faint">{rule.client_id}</span>
                    ))
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {percent(rule.percent_basis_points)}
                </TableCell>
                <TableCell className="num text-right">{money(rule.fixed_fee)}</TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{since(rule.effective_from)}</span>
                </TableCell>
                <TableCell className={STATE_VIEW[state].className}>
                  {STATE_VIEW[state].label}
                </TableCell>
                {canChange && (
                  <TableCell className="text-right">
                    {state === 'current' && <EditRule product={product} rule={rule} />}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** «Изменить»: то же окно, заполненное действующим правилом; результат — новая запись, а не правка старой. */
function EditRule({ product, rule }: { product: CommissionProduct; rule: CommissionRule }) {
  const [open, setOpen] = useState(false);
  return (
    <FormDialog
      label="Изменить"
      title="Изменить правило наценки"
      description="Заводится новое правило на место действующего; прежнее остаётся в истории."
      variant="outline"
      size="sm"
      open={open}
      onOpenChange={setOpen}
    >
      <NewCommissionRule
        product={product}
        initial={rule}
        onAdded={() => {
          setOpen(false);
        }}
      />
    </FormDialog>
  );
}

/** Микроединицы → сумма в рублях строкой (`545000` → `0.545`), без хвостовых нулей. */
const fromMicros = (value: bigint): string => {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
};

/**
 * Поля окна «Новое правило наценки». Кнопка окна не заводит правило сама, а открывает
 * подтверждение поверх него: оно называет охват и долю, и отказ API показывается там же.
 * Окно закрывается вызывающим, когда правило заведено.
 *
 * С `initial` — это «Изменить»: клиент не меняется (правило относится к нему), остальное заполнено.
 */
function NewCommissionRule({
  product,
  initial,
  onAdded,
}: {
  product: CommissionProduct;
  initial?: CommissionRule;
  onAdded: () => void;
}) {
  const text = TEXT[product];
  const maxPercent = maxBasisPoints(product) / 100;
  const queryClient = useQueryClient();
  const clients = useClients();
  const [clientId, setClientId] = useState(initial?.client_id ?? '');
  const [fixedFee, setFixedFee] = useState(initial?.fixed_fee.replace('.', ',') ?? '0');
  const [share, setShare] = useState(
    initial === undefined ? '15' : shareText(initial.percent_basis_points),
  );
  const [from, setFrom] = useState('');

  const startsAt = from === '' ? undefined : new Date(from);
  const fromValid =
    startsAt === undefined ||
    (!Number.isNaN(startsAt.getTime()) && startsAt.getTime() > Date.now());

  const add = useMutation({
    mutationFn: (input: { basisPoints: number; fee: string }) =>
      request<unknown>('/commission-rules', {
        method: 'POST',
        body: {
          product,
          ...(clientId === '' ? {} : { clientId }),
          fixedFee: input.fee,
          percentBasisPoints: input.basisPoints,
          ...(startsAt === undefined ? {} : { effectiveFrom: startsAt.toISOString() }),
        },
      }),
    onSuccess: () => {
      onAdded();
      void queryClient.invalidateQueries({ queryKey: ['commission-rules', product] });
    },
  });

  const basisPoints = basisPointsFromPercent(share);
  const shareValid = basisPoints !== undefined && basisPoints <= maxBasisPoints(product);
  const fee = moneyFromInput(fixedFee);
  const ready = shareValid && fee !== undefined && fromValid;
  const clientName = clients.nameOf(clientId) ?? clientId;

  // Пример на круглой сумме: человек видит, что получится, до подтверждения.
  let example: { base: string; markup: string; total: string } | undefined;
  if (shareValid && fee !== undefined) {
    const base = microunits(text.sample);
    const markup = microunits(fee) + (base * BigInt(basisPoints) + 9_999n) / 10_000n;
    example = { base: text.sample, markup: fromMicros(markup), total: fromMicros(base + markup) };
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        <DialogField label="Клиент" wide>
          <select
            value={clientId}
            disabled={initial !== undefined}
            onChange={(event) => {
              setClientId(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 disabled:opacity-60"
          >
            <option value="">все — правило по умолчанию</option>
            {clients.rows.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Доля, %">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={share}
            onChange={(event) => {
              setShare(event.target.value);
            }}
          />
        </DialogField>

        <DialogField label={text.feeDialog}>
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={fixedFee}
            onChange={(event) => {
              setFixedFee(event.target.value);
            }}
          />
        </DialogField>

        <DialogField label="Действует с (пусто — сразу)" wide>
          <Input
            type="datetime-local"
            className="num max-w-64"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </DialogField>

        {!shareValid && (
          <p className="text-warn sm:col-span-2">
            Доля обязательна: число от 0 до {String(maxPercent)}, не больше двух знаков после
            запятой — например 15 или 12,5.
          </p>
        )}
        {fee === undefined && (
          <p className="text-warn sm:col-span-2">
            Фикс — сумма в рублях, не больше шести знаков после запятой; ноль — без фикса.
          </p>
        )}
        {!fromValid && (
          <p className="text-warn sm:col-span-2">
            Дата начала должна быть в будущем: правило не действует задним числом.
          </p>
        )}

        {example !== undefined && (
          <p className="rounded-md bg-muted px-3 py-2 sm:col-span-2">
            Пример: {text.sampleWhat} <b className="num">{money(example.base)}</b> — наценка{' '}
            <b className="num">{money(example.markup)}</b>, клиент платит{' '}
            <b className="num">{money(example.total)}</b>.
          </p>
        )}

        <p className="text-muted-foreground sm:col-span-2">
          Прежние правила не отменяются: {text.history}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <ConfirmAction
          label={initial === undefined ? 'Добавить' : 'Сохранить'}
          variant="default"
          tone="neutral"
          disabled={!ready}
          title={
            clientId === ''
              ? 'Наценка по умолчанию — для всех клиентов'
              : `Наценка для клиента «${clientName}»`
          }
          consequence={
            <>
              <p>
                Доля <b className="num">{shareValid ? percent(String(basisPoints)) : ''}</b> и фикс{' '}
                <b className="num">{fee === undefined ? '' : money(fee)}</b> за {text.unit} начинают
                действовать {startsAt === undefined ? 'сейчас' : moment(startsAt.toISOString())} —{' '}
                {clientId === ''
                  ? 'для всех клиентов, у которых нет своего правила.'
                  : `для клиента «${clientName}».`}
              </p>
              <p>Прежние правила не отменяются: {text.history}.</p>
            </>
          }
          confirmLabel="Добавить правило"
          onConfirm={() => add.mutateAsync({ basisPoints: basisPoints ?? 0, fee: fee ?? '0' })}
        />
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}
