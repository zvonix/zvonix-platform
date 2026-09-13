'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { money } from '@/lib/money';

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
 * Цена — стоимость вызова в 60 секунд **для клиента**: тариф партнёра плюс наценка
 * площадки. Диапазон, а не одно число: цена задаётся по направлениям, и у предложения
 * их десятки.
 */
interface Offer {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly min_price: string;
  readonly max_price: string;
  readonly directions: number;
}

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

  const offerRows = offers.data?.offers ?? [];

  const saved: Record<string, string> = {};
  for (const row of current.data ?? []) {
    saved[offerKey(row.alias_id, row.termination_kind)] = String(row.priority);
  }
  const values = draft ?? saved;

  const failed = [offers.error, current.error, save.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <section className="flex flex-col gap-2">
      <h4 className="font-semibold">Порядок предложений</h4>
      <p className="text-muted-foreground">
        Пустое поле — предложение в порядке не участвует. Если пусты все, площадка сама ставит
        дешёвое раньше, и цена считается для того направления, куда идёт вызов, — это обычный режим.
        Меньший номер — раньше; равные номера делят трафик поровну.
      </p>
      <p className="text-muted-foreground">
        Цены — за вызов длительностью <span className="num">{offers.data?.seconds ?? 60}</span> с.
        Сравнивать по ним осмысленно только вызовы такой длины: тарифы с разным шагом на коротком
        вызове расходятся в разы. Полный состав — в разделе{' '}
        <Link href="/my/prices" className="underline underline-offset-2">
          «Мои цены»
        </Link>
        .
      </p>

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <div className="flex flex-col gap-1">
        {offerRows.map((offer) => {
          const key = offerKey(offer.alias_id, offer.termination_kind);
          return (
            <label key={key} className="flex items-center gap-2">
              <Input
                className="num w-[70px]"
                placeholder="—"
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
                <span className="block text-faint">
                  <Range offer={offer} /> · направлений: {offer.directions}
                </span>
              </span>
            </label>
          );
        })}

        {offers.data !== undefined && offerRows.length === 0 && (
          <p className="text-muted-foreground">
            Предложений пока нет: ни у одного партнёра не задана цена по направлениям.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={draft === undefined || save.isPending}
          onClick={() => {
            save.mutate(toPriorities(values));
          }}
        >
          Сохранить порядок
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

/** Диапазон цены: одинаковые границы показываются одним числом, а не «X–X». */
function Range({ offer }: { offer: Offer }) {
  return offer.min_price === offer.max_price ? (
    <>{money(offer.min_price)} за минуту</>
  ) : (
    <>
      {money(offer.min_price)} — {money(offer.max_price)} за минуту
    </>
  );
}

/**
 * Пустые и негодные значения выбрасываются: «не участвует» — это отсутствие строки.
 *
 * Ключ разбирается обратно на псевдоним и способ терминации: строкой он живёт только
 * в состоянии формы, а наружу уходит парой, как того и ждёт обработчик.
 */
function toPriorities(
  values: Record<string, string>,
): { aliasId: string; terminationKind: string; priority: number }[] {
  return Object.entries(values)
    .map(([key, raw]) => {
      const separator = key.lastIndexOf(':');
      return {
        aliasId: key.slice(0, separator),
        terminationKind: key.slice(separator + 1),
        priority: Number.parseInt(raw, 10),
      };
    })
    .filter((entry) => Number.isFinite(entry.priority) && entry.priority >= 1);
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

  const chosen = draft ?? new Set(current.data ?? []);
  const needle = filter.trim().toLowerCase();
  const visible = operators.rows.filter(
    (row) => needle === '' || row.name.toLowerCase().includes(needle),
  );

  const failed = [operators.error, current.error, save.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <section className="flex flex-col gap-2">
      <h4 className="font-semibold">Разрешённые операторы</h4>
      <p className="text-muted-foreground">
        Ничего не отмечено — разрешены все, и это обычный режим. Отметки нужны, когда звонить надо
        только в определённые сети: вызов на оператора вне списка отклоняется, и в вызовах это видно
        отдельной причиной.
      </p>

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <Input
        className="w-[220px]"
        placeholder="найти оператора"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />

      <div className="max-h-[220px] overflow-y-auto rounded-md border border-border p-2">
        {visible.map((row) => (
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
        {visible.length === 0 && <span className="text-muted-foreground">Ничего не найдено.</span>}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={draft === undefined || save.isPending}
          onClick={() => {
            save.mutate([...chosen]);
          }}
        >
          Сохранить список
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
