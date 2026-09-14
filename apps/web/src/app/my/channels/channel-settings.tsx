'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { integerFromInput, money } from '@/lib/money';

interface Priority {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly priority: number;
  readonly last_routed_at: string | null;
}

/**
 * Предложение партнёра вместе с тем, во что оно обходится.
 *
 * Цена — стоимость вызова эталонной длины **для клиента**: тариф партнёра плюс наценка
 * площадки, вместе с платой за соединение и минимальной длительностью. Диапазон, а не
 * одно число: цена задаётся по направлениям, и у предложения их десятки.
 */
interface Offer {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly min_price: string;
  readonly max_price: string;
  readonly directions: number;
}

/** Границы номера в порядке — те же, что проверяет API. */
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 1000;

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/** Ключ предложения: партнёр вместе со способом терминации (ADR-0040). */
function offerKey(aliasId: string, kind: TerminationKind): string {
  return `${aliasId}:${kind}`;
}

/**
 * Настройки линии, которые задаёт сам клиент.
 *
 * Обработчики существовали с самого начала и были ему открыты, но требовали
 * идентификатор канала — а перечислить свои каналы клиент не мог ничем. То есть право
 * было, а воспользоваться им было нечем.
 *
 * Оба списка **заменяются целиком**, поэтому менять их можно только после того, как
 * текущий пришёл. Раньше отметка до ответа строила черновик от пустого набора и одним
 * сохранением стирала весь порядок или весь список операторов (ui-review, 2026-09-14).
 */
export function ChannelSettings({ channelId }: { channelId: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PartnerOrder channelId={channelId} />
      <AllowedOperators channelId={channelId} />
    </div>
  );
}

/**
 * Порядок предложений ([ADR-0040](../../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
 *
 * Единица — **предложение**, то есть партнёр вместе со способом терминации: у партнёра
 * с SIM и SIP-транком это две строки со своими ценами, и решение клиента о них разное.
 *
 * Порядок можно не задавать вовсе: без него площадка сама ставит дешёвое раньше,
 * и цена берётся для того направления, куда идёт вызов. Ручной список нужен для того,
 * чего вычислить нельзя, — «этому не доверяю», «этого хочу первым несмотря на цену».
 */
function PartnerOrder({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string> | undefined>(undefined);

  const offers = useQuery({
    queryKey: ['my', 'prices'],
    queryFn: () => request<{ seconds: number; offers: Offer[] }>('/client/prices'),
    staleTime: 5 * 60_000,
  });

  const current = useQuery({
    queryKey: ['my', 'channels', channelId, 'priorities'],
    queryFn: async () =>
      (await request<{ priorities: Priority[] }>(`/channels/${channelId}/partner-priorities`))
        .priorities,
  });

  const save = useMutation({
    mutationFn: (priorities: { aliasId: string; terminationKind: string; priority: number }[]) =>
      request<unknown>(`/channels/${channelId}/partner-priorities`, {
        method: 'PUT',
        body: { priorities },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['my', 'channels', channelId, 'priorities'],
      });
    },
  });

  const loaded = offers.isSuccess && current.isSuccess;
  const offerRows = offers.data?.offers ?? [];
  const seconds = offers.data?.seconds ?? 60;

  const saved: Record<string, string> = {};
  for (const row of current.data ?? []) {
    saved[offerKey(row.alias_id, row.termination_kind)] = String(row.priority);
  }
  const values = draft ?? saved;

  // Негодное значение не выбрасывается молча, как раньше, — оно называется, и сохранить
  // такой порядок нельзя: иначе «0» или «первый» просто выпадали из порядка без единого слова.
  const invalid = offerRows.filter((offer) => {
    const raw = (values[offerKey(offer.alias_id, offer.termination_kind)] ?? '').trim();
    if (raw === '') return false;
    const parsed = integerFromInput(raw);
    return parsed === undefined || parsed < PRIORITY_MIN || parsed > PRIORITY_MAX;
  });

  const loadError = asApiError(offers.error ?? current.error);
  const saveError = asApiError(save.error);

  return (
    <section className="flex flex-col gap-2">
      <h4 className="font-semibold">Порядок предложений</h4>
      <p className="text-muted-foreground">
        Пустое поле — предложение в порядке не участвует. Если пусты все, площадка сама ставит
        дешёвое раньше, и цена считается для того направления, куда идёт вызов, — это обычный режим.
        Меньший номер — раньше; равные номера делят трафик поровну.
      </p>
      <p className="text-muted-foreground">
        Цены — за вызов длительностью <span className="num">{seconds}</span> с, вместе с платой за
        соединение. Сравнивать по ним осмысленно только вызовы такой длины: тарифы с разным шагом на
        коротком вызове расходятся в разы. Полный состав — в разделе{' '}
        <Link href="/my/prices" className="underline underline-offset-2">
          «Мои цены»
        </Link>
        .
      </p>

      {loadError !== undefined && <ErrorNote error={loadError} />}
      {!loaded && loadError === undefined && (
        <p className="text-muted-foreground">Загружаем порядок…</p>
      )}

      <div className="flex flex-col gap-1">
        {offerRows.map((offer) => {
          const key = offerKey(offer.alias_id, offer.termination_kind);
          return (
            <label key={key} className="flex items-center gap-2">
              <Input
                className="num w-[70px]"
                inputMode="numeric"
                autoComplete="off"
                placeholder="—"
                disabled={!loaded}
                value={values[key] ?? ''}
                onChange={(event) => {
                  setDraft({ ...values, [key]: event.target.value });
                }}
              />
              <span className="min-w-0">
                {offer.display_name}
                {/* Клиент не обязан знать наши слова: что такое SIP, объясняется тут же. */}
                <span
                  className="text-muted-foreground"
                  title={TERMINATION_KIND_MEANING[offer.termination_kind]}
                >
                  {' · '}
                  {TERMINATION_KIND_NAME[offer.termination_kind]}
                </span>
                <span className="block text-muted-foreground">
                  <Range offer={offer} seconds={seconds} /> · направлений: {offer.directions}
                </span>
              </span>
            </label>
          );
        })}

        {offers.isSuccess && offerRows.length === 0 && (
          <p className="text-muted-foreground">
            Предложений пока нет: ни у одного партнёра не задана цена по направлениям.
          </p>
        )}
      </div>

      {invalid.length > 0 && (
        <p className="text-warn">
          Номер в порядке — целое число от {PRIORITY_MIN} до {PRIORITY_MAX}. Исправьте:{' '}
          {invalid.map((offer) => offer.display_name).join(', ')}.
        </p>
      )}

      {saveError !== undefined && <ErrorNote error={saveError} />}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!loaded || draft === undefined || invalid.length > 0 || save.isPending}
          onClick={() => {
            save.mutate(toPriorities(values));
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить порядок'}
        </Button>
        {draft !== undefined && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(undefined);
            }}
          >
            Отмена
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Диапазон цены: одинаковые границы показываются одним числом, а не «X–X».
 *
 * «За вызов N с», а не «за минуту»: это стоимость эталонного вызова вместе с платой
 * за соединение и минимумом, и цена за минуту у того же предложения бывает другой.
 */
function Range({ offer, seconds }: { offer: Offer; seconds: number }) {
  const per = `за вызов ${String(seconds)}\u00A0с`;
  return offer.min_price === offer.max_price ? (
    <>
      {money(offer.min_price)} {per}
    </>
  ) : (
    <>
      {money(offer.min_price)} — {money(offer.max_price)} {per}
    </>
  );
}

/**
 * Пустые значения выбрасываются: «не участвует» — это отсутствие строки.
 *
 * Негодные сюда не доходят — сохранение с ними запрещено выше. Ключ разбирается обратно
 * на псевдоним и способ терминации: строкой он живёт только в состоянии формы, а наружу
 * уходит парой, как того и ждёт обработчик.
 */
function toPriorities(
  values: Record<string, string>,
): { aliasId: string; terminationKind: string; priority: number }[] {
  return Object.entries(values).flatMap(([key, raw]) => {
    const priority = integerFromInput(raw);
    if (priority === undefined) return [];
    const separator = key.lastIndexOf(':');
    return [
      {
        aliasId: key.slice(0, separator),
        terminationKind: key.slice(separator + 1),
        priority,
      },
    ];
  });
}

/**
 * Операторы, на которых линии разрешено звонить ([ADR-0025](../../../../../../docs/adr/0025-razreshyonnye-operatory-kanala.md)).
 *
 * Пустой список означает «все», а не «ни одного»: иначе новая линия не смогла бы
 * позвонить, пока кто-то её не заполнит.
 */
function AllowedOperators({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Set<string> | undefined>(undefined);

  const current = useQuery({
    queryKey: ['my', 'channels', channelId, 'allowed-operators'],
    queryFn: async () =>
      (await request<{ operators: string[] }>(`/channels/${channelId}/allowed-operators`))
        .operators,
  });

  const save = useMutation({
    mutationFn: (chosen: string[]) =>
      request<unknown>(`/channels/${channelId}/allowed-operators`, {
        method: 'PUT',
        body: { operators: chosen },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['my', 'channels', channelId, 'allowed-operators'],
      });
    },
  });

  const loaded = current.isSuccess && operators.ready;
  const chosen = draft ?? new Set(current.data ?? []);
  const needle = filter.trim().toLowerCase();
  const visible = operators.rows.filter(
    (row) => needle === '' || row.name.toLowerCase().includes(needle),
  );

  const loadError = asApiError(operators.error ?? current.error);
  const saveError = asApiError(save.error);

  return (
    <section className="flex flex-col gap-2">
      <h4 className="font-semibold">Разрешённые операторы</h4>
      <p className="text-muted-foreground">
        Ничего не отмечено — разрешены все, и это обычный режим. Отметки нужны, когда звонить надо
        только в определённые сети: вызов на оператора вне списка отклоняется, и в вызовах это видно
        отдельной причиной.
      </p>

      {loadError !== undefined && <ErrorNote error={loadError} />}

      <Input
        className="w-[220px]"
        aria-label="Найти оператора"
        placeholder="найти оператора…"
        autoComplete="off"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />

      <div className="max-h-[220px] overflow-y-auto rounded-md border border-border p-2">
        {!loaded && loadError === undefined && (
          <span className="text-muted-foreground">Загружаем…</span>
        )}
        {loaded &&
          visible.map((row) => (
            <label key={row.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chosen.has(row.id)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  setDraft(next);
                }}
              />
              <span>{row.name}</span>
            </label>
          ))}
        {loaded && visible.length === 0 && (
          <span className="text-muted-foreground">Ничего не найдено.</span>
        )}
      </div>

      {saveError !== undefined && <ErrorNote error={saveError} />}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!loaded || draft === undefined || save.isPending}
          onClick={() => {
            save.mutate([...chosen]);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить список'}
        </Button>
        {draft !== undefined && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(undefined);
            }}
          >
            Отмена
          </Button>
        )}
      </div>
    </section>
  );
}
