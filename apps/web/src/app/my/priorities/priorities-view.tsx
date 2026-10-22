'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_PRIORITY_MAX, type TerminationKind } from '@zvonix/shared';
import { useMemo, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { integerFromInput, microunits, money } from '@/lib/money';
import { CallRequirementsForm, type CallRequirements } from './call-requirements-form';

/** Предложение партнёра: у звонков — SIM или транк, у сообщений — MAX. Цена — только у звонков. */
interface Offer {
  readonly aliasId: string;
  readonly name: string;
  readonly offer: 'sim' | 'sip' | 'message';
  readonly price: string | null;
  /** Только у звонков: границы цены, слушает ли партнёр записи (ADR-0095). */
  readonly minPrice?: string;
  readonly maxPrice?: string;
  readonly listens?: boolean;
}

/** Почему предложение не подходит под требования; `partial` — подходит не на всех направлениях. */
function mismatch(
  offer: Offer,
  requirements: CallRequirements | undefined,
): { reasons: string[]; partial: boolean } {
  if (requirements === undefined || offer.offer === 'message')
    return { reasons: [], partial: false };
  const reasons: string[] = [];
  if (requirements.termination_kind !== null && offer.offer !== requirements.termination_kind) {
    reasons.push(`только ${TERMINATION_KIND_NAME[requirements.termination_kind]}`);
  }
  if (requirements.no_recording_listeners && offer.listens === true) reasons.push('слушает записи');
  let partial = false;
  if (
    requirements.max_price !== null &&
    offer.minPrice !== undefined &&
    offer.maxPrice !== undefined
  ) {
    const cap = microunits(requirements.max_price);
    if (microunits(offer.minPrice) > cap) reasons.push('дороже вашего предела');
    else if (microunits(offer.maxPrice) > cap) partial = true;
  }
  return { reasons, partial };
}

interface Stored {
  readonly alias_id: string;
  readonly offer: Offer['offer'];
  readonly priority: number | null;
}

/** Значение поля: пусто — партнёра в списке нет (идёт после названных), «x» — не использовать. */
const BANNED = 'x';

/** Цена или диапазон цен: одинаковые границы — одним числом. */
const priceRange = (low: string, high: string): string =>
  low === high ? money(low) : `${money(low)} — ${money(high)}`;

const keyOf = (offer: Pick<Offer, 'aliasId' | 'offer'>) => `${offer.aliasId}:${offer.offer}`;

/**
 * Один список приоритетов клиента ([ADR-0081](../../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)):
 * цифра у партнёра, одна цифра у нескольких — по очереди, нет свободных — следующая цифра. Пусто — партнёр идёт после
 * названных, «не использовать» — не берётся совсем.
 */
export function Priorities({ product }: { product: 'calls' | 'messages' }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string> | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState('');

  const offers = useQuery({
    queryKey: ['my', 'priorities', 'offers', product],
    queryFn: async (): Promise<Offer[]> => {
      if (product === 'messages') {
        const { offers: rows } = await request<{
          offers: {
            alias_id: string;
            display_name: string;
            min_price: string;
            max_price: string;
          }[];
        }>('/client/messages/offers');
        return rows.map((row) => ({
          aliasId: row.alias_id,
          name: row.display_name,
          offer: 'message',
          price: priceRange(row.min_price, row.max_price),
        }));
      }
      const { offers: rows } = await request<{
        offers: {
          alias_id: string;
          display_name: string;
          termination_kind: TerminationKind;
          min_price: string;
          max_price: string;
          listens_to_recordings: boolean;
        }[];
      }>('/client/prices');
      return rows.map((row) => ({
        aliasId: row.alias_id,
        name: row.display_name,
        offer: row.termination_kind,
        price: priceRange(row.min_price, row.max_price),
        minPrice: row.min_price,
        maxPrice: row.max_price,
        listens: row.listens_to_recordings,
      }));
    },
    staleTime: 5 * 60_000,
  });

  const stored = useQuery({
    queryKey: ['my', 'priorities', 'list', product],
    queryFn: async () =>
      (await request<{ priorities: Stored[] }>(`/client/partner-priorities?product=${product}`))
        .priorities,
  });

  const requirements = useQuery({
    queryKey: ['my', 'call-requirements'],
    queryFn: async () =>
      (await request<{ requirements: CallRequirements }>('/client/call-requirements')).requirements,
    enabled: product === 'calls',
  });

  const save = useMutation({
    mutationFn: (priorities: { aliasId: string; offer: string; priority: number | null }[]) =>
      request<unknown>(`/client/partner-priorities?product=${product}`, {
        method: 'PUT',
        body: { priorities },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      setPicked(new Set());
      await queryClient.invalidateQueries({ queryKey: ['my', 'priorities', 'list', product] });
    },
  });

  const loaded = offers.isSuccess && stored.isSuccess;
  const saved = useMemo(() => {
    const result: Record<string, string> = {};
    for (const row of stored.data ?? []) {
      result[keyOf({ aliasId: row.alias_id, offer: row.offer })] =
        row.priority === null ? BANNED : String(row.priority);
    }
    return result;
  }, [stored.data]);
  const values = draft ?? saved;

  const all = offers.data ?? [];
  const shown = all.filter((offer) =>
    offer.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')),
  );

  const isValid = (raw: string): boolean => {
    if (raw === '' || raw === BANNED) return true;
    const parsed = integerFromInput(raw);
    return parsed !== undefined && parsed >= 1 && parsed <= CLIENT_PRIORITY_MAX;
  };
  const invalid = all.filter((offer) => !isValid((values[keyOf(offer)] ?? '').trim()));

  const change = (keys: Iterable<string>, value: string) => {
    const next = { ...values };
    for (const key of keys) {
      if (value === '') Reflect.deleteProperty(next, key);
      else next[key] = value;
    }
    setDraft(next);
  };

  const error = [offers.error, stored.error, save.error, requirements.error].find(
    (e) => e instanceof ApiError,
  );
  const calls = product === 'calls';
  const fitting = calls
    ? all.filter(
        (offer) =>
          values[keyOf(offer)] !== BANNED &&
          mismatch(offer, requirements.data).reasons.length === 0,
      ).length
    : 0;

  return (
    <div className="flex flex-col gap-3">
      {calls && requirements.data !== undefined && (
        <CallRequirementsForm current={requirements.data} />
      )}
      {calls && loaded && requirements.data !== undefined && all.length > 0 && (
        <p className={fitting === 0 ? 'text-warn' : 'text-muted-foreground'}>
          Подходят {String(fitting)} из {String(all.length)}
          {fitting === 0 && ' — звонки не пройдут, пока вы не смягчите требования'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Найти партнёра"
          placeholder="Найти партнёра"
          className="w-[220px]"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <Hint label="Как работают приоритеты">
          <p>
            Очерёдность 1 — первыми, дальше 2, 3… Если у нескольких партнёров одна очерёдность, они
            используются по очереди (сначала дешевле). Когда у партнёров с очерёдностью 1 всё занято
            или исчерпаны лимиты, берутся партнёры с очерёдностью 2 и так далее.
          </p>
          <p className="mt-2">
            Пусто — партнёр идёт после всех названных. «Не использовать» — не берётся совсем. Для
            отдельной линии можно задать свой порядок в «Линии»: он главнее этого списка.
          </p>
        </Hint>
      </div>

      {error instanceof ApiError && <ErrorNote error={error} />}
      {!loaded && error === undefined && <p className="text-muted-foreground">Загружаем…</p>}

      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
          <span>Выбрано: {picked.size}</span>
          <Input
            aria-label="Очерёдность для выбранных"
            className="num w-[80px]"
            inputMode="numeric"
            placeholder="номер"
            value={bulk}
            onChange={(event) => {
              setBulk(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!isValid(bulk) || bulk === ''}
            onClick={() => {
              change(picked, bulk);
            }}
          >
            Задать
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              change(picked, BANNED);
            }}
          >
            Не использовать
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              change(picked, '');
            }}
          >
            Убрать из списка
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8 w-8">
                <input
                  type="checkbox"
                  aria-label="Выбрать всех показанных"
                  checked={shown.length > 0 && shown.every((offer) => picked.has(keyOf(offer)))}
                  onChange={(event) => {
                    setPicked(event.target.checked ? new Set(shown.map(keyOf)) : new Set());
                  }}
                />
              </TableHead>
              <TableHead className="h-8">Партнёр</TableHead>
              {product === 'calls' && <TableHead className="h-8">Через что</TableHead>}
              <TableHead className="h-8 text-right">
                {product === 'calls' ? 'Цена за вызов' : 'Цена за сообщение'}
              </TableHead>
              {calls && <TableHead className="h-8">Записи</TableHead>}
              {calls && <TableHead className="h-8">Подходит</TableHead>}
              <TableHead className="h-8">Очерёдность</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded && shown.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={calls ? 7 : 5}
                  className="whitespace-normal text-muted-foreground"
                >
                  {all.length === 0 ? 'Партнёров пока нет.' : 'Никого не нашли: измените запрос.'}
                </TableCell>
              </TableRow>
            )}
            {shown.map((offer) => {
              const key = keyOf(offer);
              const value = values[key] ?? '';
              return (
                <TableRow key={key}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${offer.name}`}
                      checked={picked.has(key)}
                      onChange={(event) => {
                        const next = new Set(picked);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        setPicked(next);
                      }}
                    />
                  </TableCell>
                  <TableCell>{offer.name}</TableCell>
                  {product === 'calls' && (
                    <TableCell
                      className="text-muted-foreground"
                      title={
                        offer.offer === 'message'
                          ? undefined
                          : TERMINATION_KIND_MEANING[offer.offer]
                      }
                    >
                      {offer.offer === 'message' ? '' : TERMINATION_KIND_NAME[offer.offer]}
                    </TableCell>
                  )}
                  <TableCell className="num text-right">{offer.price ?? '—'}</TableCell>
                  {calls && (
                    <TableCell>
                      {offer.listens === true ? (
                        'слушает'
                      ) : (
                        <span className="text-muted-foreground">не слушает</span>
                      )}
                    </TableCell>
                  )}
                  {calls && (
                    <FitCell
                      offer={offer}
                      banned={value === BANNED}
                      requirements={requirements.data}
                    />
                  )}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Очерёдность: ${offer.name}`}
                        className="num w-[70px]"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="—"
                        disabled={!loaded || value === BANNED}
                        value={value === BANNED ? '' : value}
                        onChange={(event) => {
                          change([key], event.target.value.trim());
                        }}
                      />
                      <label className="flex items-center gap-1 text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={value === BANNED}
                          disabled={!loaded}
                          onChange={(event) => {
                            change([key], event.target.checked ? BANNED : '');
                          }}
                        />
                        не использовать
                      </label>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {invalid.length > 0 && (
        <p className="text-warn">
          Очерёдность — целое число от 1 до {CLIENT_PRIORITY_MAX}. Исправьте:{' '}
          {invalid.map((offer) => offer.name).join(', ')}.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!loaded || draft === undefined || invalid.length > 0 || save.isPending}
          onClick={() => {
            save.mutate(
              Object.entries(values).flatMap(([key, raw]) => {
                const [aliasId = '', offer = ''] = key.split(':');
                if (raw === '') return [];
                const parsed = raw === BANNED ? null : integerFromInput(raw);
                if (parsed === undefined) return [];
                return [{ aliasId, offer, priority: parsed }];
              }),
            );
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
              setPicked(new Set());
            }}
          >
            Отмена
          </Button>
        )}
      </div>
    </div>
  );
}

function FitCell({
  offer,
  banned,
  requirements,
}: {
  offer: Offer;
  banned: boolean;
  requirements: CallRequirements | undefined;
}) {
  if (banned) {
    return <TableCell className="text-muted-foreground">не используется</TableCell>;
  }
  const { reasons, partial } = mismatch(offer, requirements);
  return (
    <TableCell className="whitespace-normal">
      {reasons.length > 0 ? (
        <span className="text-warn">нет: {reasons.join(', ')}</span>
      ) : partial ? (
        <span title="На части направлений цена выше вашего предела — туда звонки через этого партнёра не пойдут">
          <span className="text-ok">да</span>
          <span className="text-muted-foreground">, кроме дорогих направлений</span>
        </span>
      ) : (
        <span className="text-ok">да</span>
      )}
    </TableCell>
  );
}
