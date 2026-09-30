'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMIT_METRICS, LIMIT_WINDOWS, type LimitMetric, type LimitWindow } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
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
import { useChannels, useClients, usePartners, useSimCards } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { LIMIT_METRIC_NAME, LIMIT_WINDOW_NAME, limitRuleNote } from '@/lib/labels';
import { integerFromInput } from '@/lib/money';

const COLUMNS = 5;

/** Верхняя граница предела — та же, что проверяет API. */
const LIMIT_MAX = 10_000_000;

interface Rule {
  readonly id: string;
  readonly client_id: string | null;
  readonly channel_id: string | null;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  readonly window: LimitWindow;
  readonly metric: LimitMetric;
  readonly value: number;
  readonly per_sim: boolean;
  readonly rounding: 'second' | 'minute';
  readonly period_start_day: number | null;
  readonly set_by: 'platform' | 'partner';
  /** У правила «на каждую карту» — карта этой строки (ADR-0057). */
  readonly usage_sim_card_id: string | null;
  readonly bucket_start: string;
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

/** Субъект лимита: ровно один из четырёх, и поле в запросе у каждого своё. */
const SUBJECT_FIELD = {
  client: 'clientId',
  channel: 'channelId',
  partner: 'partnerId',
  sim: 'simCardId',
} as const;

type SubjectKind = keyof typeof SUBJECT_FIELD;

const SUBJECT_NAME: Record<SubjectKind, string> = {
  client: 'Клиент',
  channel: 'Канал',
  partner: 'Партнёр',
  sim: 'SIM',
};

const isSubjectKind = (value: string): value is SubjectKind => value in SUBJECT_FIELD;

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Лимиты по окнам ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Это в первую очередь **защита SIM партнёра**, и только во вторую — ограничение
 * клиента: оператор блокирует SIM за нечеловеческий профиль трафика, а потерянная SIM
 * означает потерянного партнёра.
 *
 * До этого экрана лимит заводился только через `curl` — то есть увидеть, что вообще
 * ограничено и насколько израсходовано, было нельзя ниоткуда, а `limit_exceeded`
 * в разборе вызовов оставался причиной без объяснения.
 *
 * Заведение и правка предела — окнами по центру, снятие — подтверждением из строки.
 *
 * Предел разбирается строго: `Number.parseInt` читал «1 000» как 1, и лимит «тысяча
 * вызовов» сохранялся лимитом в один вызов (ui-review, 2026-09-14).
 */
export function LimitRules() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const clients = useClients();
  const channels = useChannels();
  const partners = usePartners();
  const sims = useSimCards();

  const list = useQuery({
    queryKey: ['limits'],
    queryFn: () => request<{ limits: Rule[] }>('/limits'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['limits'] });
  };

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<{ limit: Rule }>('/limits', { method: 'POST', body }),
    onSuccess: refresh,
  });

  const change = useMutation({
    mutationFn: (input: { id: string; value: number }) =>
      request<{ limit: Rule }>(`/limits/${input.id}`, {
        method: 'PUT',
        body: { value: input.value },
      }),
    onSuccess: refresh,
  });

  // Снятие идёт через подтверждение, и его отказ показывается там же.
  const remove = useMutation({
    mutationFn: (id: string) => request<{ limit: Rule }>(`/limits/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await atMost(refresh());
    },
  });

  // Отказы заведения и правки показывает их окно, здесь — только отказ списка.
  const failed = asApiError(list.error);

  /**
   * Кого ограничивает правило: у лимита заполнено ровно одно из четырёх полей.
   *
   * Не нашлось имени — показывается идентификатор: субъект могли завести только что,
   * и справочник в кэше о нём ещё не знает. Пустая ячейка читалась бы как «ничей».
   */
  const describe = (rule: Rule): { kind: SubjectKind; name: string } => {
    if (rule.client_id !== null) {
      return { kind: 'client', name: clients.nameOf(rule.client_id) ?? rule.client_id };
    }
    if (rule.channel_id !== null) {
      return { kind: 'channel', name: channels.nameOf(rule.channel_id) ?? rule.channel_id };
    }
    if (rule.partner_id !== null) {
      return { kind: 'partner', name: partners.nameOf(rule.partner_id) ?? rule.partner_id };
    }
    return {
      kind: 'sim',
      name: rule.sim_card_id === null ? '—' : (sims.nameOf(rule.sim_card_id) ?? rule.sim_card_id),
    };
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Лимиты по окнам</h2>
        {canChange && (
          <FormDialog label="Добавить лимит" title="Новый лимит" className="ml-auto">
            <NewLimitForm onCreate={(body) => add.mutateAsync(body)} />
          </FormDialog>
        )}
      </div>
      <p className="text-muted-foreground">
        Окно календарное и в UTC, а не скользящее: видно, когда счётчик обнулится — в полночь, в
        понедельник, первого числа. Звонки считаются штуками, минуты — секундами: разговор в 90
        секунд это не «полторы минуты» и не «одна».
      </p>

      {failed !== undefined && <ErrorNote error={failed} />}

      {!canChange && <ReadOnly what="лимиты" />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Кого</TableHead>
              <TableHead className="h-8">Ограничение</TableHead>
              <TableHead className="h-8">Израсходовано</TableHead>
              <TableHead className="h-8">Окно с</TableHead>
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

            {list.data?.limits.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Лимитов нет — значит, не ограничен никто. Для SIM это заметно: оператор блокирует
                  карту за нечеловеческий профиль трафика, а потерянная SIM означает потерянного
                  партнёра.
                </TableCell>
              </TableRow>
            )}

            {list.data?.limits.map((rule) => {
              const subjectOf = describe(rule);
              const subjectTitle = `${SUBJECT_NAME[subjectOf.kind].toLowerCase()} «${subjectOf.name}»`;
              return (
                <TableRow key={`${rule.id}:${rule.usage_sim_card_id ?? ''}`}>
                  <TableCell>
                    {subjectOf.name}
                    <span className="block text-faint">{SUBJECT_NAME[subjectOf.kind]}</span>
                  </TableCell>

                  <TableCell>
                    <span className="num">{rule.value}</span> {LIMIT_METRIC_NAME[rule.metric]}{' '}
                    {LIMIT_WINDOW_NAME[rule.window]}
                    <span className="block text-faint">{limitRuleNote(rule)}</span>
                    {rule.usage_sim_card_id !== null && (
                      <span className="num block text-faint">
                        карта {sims.nameOf(rule.usage_sim_card_id) ?? rule.usage_sim_card_id}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    <span className={rule.exceeded ? 'num text-crit' : 'num'}>{rule.used}</span>
                    {rule.exceeded && (
                      <span className="block text-crit">исчерпан — вызовы отклоняются</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <span className="num text-muted-foreground">{moment(rule.bucket_start)}</span>
                  </TableCell>

                  <TableCell>
                    {canChange && (
                      <div className="flex flex-wrap items-center gap-2">
                        <FormDialog
                          label="Изменить"
                          variant="outline"
                          title={`Предел лимита: ${subjectTitle}`}
                          description={
                            <>
                              Сейчас <span className="num">{rule.value}</span>{' '}
                              {LIMIT_METRIC_NAME[rule.metric]} {LIMIT_WINDOW_NAME[rule.window]}.
                            </>
                          }
                        >
                          <ChangeValue
                            rule={rule}
                            onSave={(next) => change.mutateAsync({ id: rule.id, value: next })}
                          />
                        </FormDialog>
                        <RemoveLimit
                          rule={rule}
                          subjectTitle={subjectTitle}
                          isSim={subjectOf.kind === 'sim'}
                          busy={remove.isPending}
                          onRemove={() => remove.mutateAsync(rule.id)}
                        />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Поля окна «Новый лимит». */
function NewLimitForm({
  onCreate,
}: {
  onCreate: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const clients = useClients();
  const channels = useChannels();
  const partners = usePartners();
  const sims = useSimCards();

  const [subject, setSubject] = useState('');
  const [window, setWindow] = useState<LimitWindow>('day');
  const [metric, setMetric] = useState<LimitMetric>('calls');
  const [value, setValue] = useState('');

  const amount = integerFromInput(value);
  const valueValid = amount !== undefined && amount >= 1 && amount <= LIMIT_MAX;
  const [kind = '', id = ''] = subject.split(':');
  const ready = isSubjectKind(kind) && id !== '' && valueValid;

  return (
    <DialogForm
      submitLabel="Добавить лимит"
      canSubmit={ready}
      onSubmit={async () => {
        if (!isSubjectKind(kind)) return;
        await onCreate({ [SUBJECT_FIELD[kind]]: id, window, metric, value: amount });
      }}
    >
      {/*
        Один список вместо связки «сначала род, потом объект»: субъектов на площадке
        десятки, и лишний шаг здесь дороже длины списка. Когда SIM станут сотнями,
        понадобится поиск по мере ввода — тогда и появится.
      */}
      <DialogField label="Кого ограничиваем" wide>
        <select
          value={subject}
          autoFocus
          onChange={(event) => {
            setSubject(event.target.value);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="">выберите</option>
          <optgroup label="Клиенты">
            {clients.rows.map((row) => (
              <option key={row.id} value={`client:${row.id}`}>
                {row.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Каналы">
            {channels.rows.map((row) => (
              <option key={row.id} value={`channel:${row.id}`}>
                {row.name}
                {row.ownerId === undefined ? '' : ` · ${clients.nameOf(row.ownerId) ?? ''}`}
              </option>
            ))}
          </optgroup>
          <optgroup label="Партнёры">
            {partners.rows.map((row) => (
              <option key={row.id} value={`partner:${row.id}`}>
                {row.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="SIM">
            {sims.rows.map((row) => (
              <option key={row.id} value={`sim:${row.id}`}>
                {row.name}
                {row.ownerId === undefined ? '' : ` · ${partners.nameOf(row.ownerId) ?? ''}`}
              </option>
            ))}
          </optgroup>
        </select>
      </DialogField>

      <DialogField label="Не больше">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          placeholder="100"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Чего">
        <select
          value={metric}
          onChange={(event) => {
            setMetric(event.target.value as LimitMetric);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          {LIMIT_METRICS.map((item) => (
            <option key={item} value={item}>
              {LIMIT_METRIC_NAME[item]}
            </option>
          ))}
        </select>
      </DialogField>

      <DialogField label="За окно">
        <select
          value={window}
          onChange={(event) => {
            setWindow(event.target.value as LimitWindow);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          {LIMIT_WINDOWS.map((item) => (
            <option key={item} value={item}>
              {LIMIT_WINDOW_NAME[item]}
            </option>
          ))}
        </select>
      </DialogField>

      {value !== '' && !valueValid && (
        <p className="text-warn sm:col-span-2">
          Предел — целое число от 1 до 10 000 000: без запятой и букв.
        </p>
      )}
    </DialogForm>
  );
}

/** Поле окна правки предела. */
function ChangeValue({
  rule,
  onSave,
}: {
  rule: Rule;
  onSave: (value: number) => Promise<unknown>;
}) {
  const [value, setValue] = useState(String(rule.value));
  const amount = integerFromInput(value);
  const valid = amount !== undefined && amount >= 1 && amount <= LIMIT_MAX;
  const changed = valid && amount !== rule.value;

  return (
    <DialogForm
      submitLabel="Сохранить предел"
      canSubmit={changed}
      onSubmit={async () => {
        if (amount !== undefined) await onSave(amount);
      }}
    >
      <DialogField label="Новый предел">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>
      {!valid && (
        <p className="text-warn sm:col-span-2">Предел — целое число от 1 до 10 000 000.</p>
      )}
    </DialogForm>
  );
}

/**
 * Снятие лимита.
 *
 * Снятие уносит и счётчики — это и есть способ обнулить израсходованное, когда предел
 * исчерпан по ошибке, а ждать конца окна нельзя. Именно поэтому оно через
 * подтверждение: у SIM это снятие защиты, и раньше срабатывало с первого нажатия.
 */
function RemoveLimit({
  rule,
  subjectTitle,
  isSim,
  busy,
  onRemove,
}: {
  rule: Rule;
  subjectTitle: string;
  isSim: boolean;
  busy: boolean;
  onRemove: () => Promise<unknown>;
}) {
  return (
    <ConfirmAction
      label="Снять лимит"
      title={`Снять лимит: ${subjectTitle}`}
      consequence={
        <>
          <p>
            Лимит удаляется вместе со счётчиком израсходованного: ограничения на{' '}
            {LIMIT_METRIC_NAME[rule.metric]} {LIMIT_WINDOW_NAME[rule.window]} больше не будет.
          </p>
          {isSim && (
            <p>
              Для SIM это снятие защиты: оператор блокирует карту за нечеловеческий профиль трафика,
              а потерянная SIM означает потерянного партнёра.
            </p>
          )}
        </>
      }
      confirmLabel="Снять лимит"
      disabled={busy}
      onConfirm={onRemove}
    />
  );
}
