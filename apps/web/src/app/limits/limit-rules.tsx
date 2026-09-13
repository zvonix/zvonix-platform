'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMIT_METRICS, LIMIT_WINDOWS, type LimitMetric, type LimitWindow } from '@zvonix/shared';
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
import { useChannels, useClients, usePartners, useSimCards } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { LIMIT_METRIC_NAME, LIMIT_WINDOW_NAME } from '@/lib/labels';

const COLUMNS = 5;

interface Rule {
  readonly id: string;
  readonly client_id: string | null;
  readonly channel_id: string | null;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  readonly window: LimitWindow;
  readonly metric: LimitMetric;
  readonly value: number;
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
 */
export function LimitRules() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const clients = useClients();
  const channels = useChannels();
  const partners = usePartners();
  const sims = useSimCards();

  const [subject, setSubject] = useState('');
  const [window, setWindow] = useState<LimitWindow>('day');
  const [metric, setMetric] = useState<LimitMetric>('calls');
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState<string | undefined>(undefined);

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
    onSuccess: async () => {
      setValue('');
      await refresh();
    },
  });

  const change = useMutation({
    mutationFn: (input: { id: string; value: number }) =>
      request<{ limit: Rule }>(`/limits/${input.id}`, {
        method: 'PUT',
        body: { value: input.value },
      }),
    onSuccess: async () => {
      setEditing(undefined);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => request<{ limit: Rule }>(`/limits/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const amount = Number.parseInt(value, 10);
  const ready = subject !== '' && Number.isFinite(amount) && amount >= 1;
  const failed = [add.error, change.error, remove.error, list.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

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
      <h2 className="text-[15px] font-semibold tracking-tight">Лимиты по окнам</h2>
      <p className="text-muted-foreground">
        Окно календарное и в UTC, а не скользящее: видно, когда счётчик обнулится — в полночь, в
        понедельник, первого числа. Звонки считаются штуками, минуты — секундами: разговор в 90
        секунд это не «полторы минуты» и не «одна».
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
            if (!ready) return;
            const [kind, id] = subject.split(':');
            if (kind === undefined || id === undefined) return;
            add.mutate({
              [SUBJECT_FIELD[kind as SubjectKind]]: id,
              window,
              metric,
              value: amount,
            });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Кого ограничиваем</span>
            {/*
              Один список вместо связки «сначала род, потом объект»: субъектов на площадке
              десятки, и лишний шаг здесь дороже длины списка. Когда SIM станут сотнями,
              понадобится поиск по мере ввода — тогда и появится.
            */}
            <select
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
              className="h-9 w-[280px] rounded-md border border-input bg-transparent px-2"
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
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Не больше</span>
            <Input
              className="num w-[110px]"
              placeholder="100"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Чего</span>
            <select
              value={metric}
              onChange={(event) => {
                setMetric(event.target.value as LimitMetric);
              }}
              className="h-9 w-[180px] rounded-md border border-input bg-transparent px-2"
            >
              {LIMIT_METRICS.map((item) => (
                <option key={item} value={item}>
                  {LIMIT_METRIC_NAME[item]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">За окно</span>
            <select
              value={window}
              onChange={(event) => {
                setWindow(event.target.value as LimitWindow);
              }}
              className="h-9 w-[130px] rounded-md border border-input bg-transparent px-2"
            >
              {LIMIT_WINDOWS.map((item) => (
                <option key={item} value={item}>
                  {LIMIT_WINDOW_NAME[item]}
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" size="sm" disabled={!ready || add.isPending}>
            Завести лимит
          </Button>
        </form>
      ) : (
        <ReadOnly what="лимиты" />
      )}

      <div className="rounded-lg border border-border bg-card">
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
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    {subjectOf.name}
                    <span className="block text-faint">{SUBJECT_NAME[subjectOf.kind]}</span>
                  </TableCell>

                  <TableCell>
                    <span className="num">{rule.value}</span> {LIMIT_METRIC_NAME[rule.metric]}{' '}
                    {LIMIT_WINDOW_NAME[rule.window]}
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
                    {canChange &&
                      (editing === rule.id ? (
                        <ChangeValue
                          rule={rule}
                          busy={change.isPending || remove.isPending}
                          onSave={(next) => {
                            change.mutate({ id: rule.id, value: next });
                          }}
                          onRemove={() => {
                            remove.mutate(rule.id);
                          }}
                          onCancel={() => {
                            setEditing(undefined);
                          }}
                        />
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(rule.id);
                          }}
                        >
                          Изменить
                        </Button>
                      ))}
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

/**
 * Правка предела и снятие лимита.
 *
 * Снятие уносит и счётчики — это и есть способ обнулить израсходованное, когда предел
 * исчерпан по ошибке, а ждать конца окна нельзя.
 */
function ChangeValue({
  rule,
  busy,
  onSave,
  onRemove,
  onCancel,
}: {
  rule: Rule;
  busy: boolean;
  onSave: (value: number) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(rule.value));
  const amount = Number.parseInt(value, 10);
  const changed = Number.isFinite(amount) && amount >= 1 && amount !== rule.value;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onSave(amount);
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <Input
        className="num w-[110px]"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <Button type="submit" size="sm" disabled={!changed || busy}>
        Сохранить
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRemove}>
        Снять лимит
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Отмена
      </Button>
      <span className="text-muted-foreground">Снятие обнуляет и счётчик.</span>
    </form>
  );
}
