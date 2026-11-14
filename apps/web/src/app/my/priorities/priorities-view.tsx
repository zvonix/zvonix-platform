'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_PRIORITY_MAX, type TerminationKind } from '@zvonix/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
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

/**
 * Маршрут — одна SIM или один SIP-провайдер партнёра
 * ([ADR-0120](../../../../../../docs/adr/0120-poryadok-otdelnyh-sim-i-sip-u-klienta.md)).
 */
interface Route {
  readonly route_id: string;
  readonly kind: TerminationKind;
  readonly alias_id: string;
  readonly display_name: string;
  readonly number: number;
  readonly min_price: string;
  readonly max_price: string;
  readonly listens_to_recordings: boolean;
  readonly available: boolean;
  readonly created_at: string;
  readonly configured: boolean;
  readonly priority: number | null;
}

/** Ключ маршрута в общем черновике; у предложения ключ без приставки. */
const routeKey = (route: Pick<Route, 'kind' | 'route_id'>) => `r:${route.kind}:${route.route_id}`;

const routeName = (route: Route) =>
  `${route.display_name} · ${TERMINATION_KIND_NAME[route.kind]} ${String(route.number)}`;

/** Новый маршрут — заведён меньше недели назад: клиент мог ещё не решить, где ему место. */
const NEW_ROUTE_MS = 7 * 24 * 60 * 60_000;

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

const routeAsOffer = (route: Route): Offer => ({
  aliasId: route.alias_id,
  name: routeName(route),
  offer: route.kind,
  price: priceRange(route.min_price, route.max_price),
  minPrice: route.min_price,
  maxPrice: route.max_price,
  listens: route.listens_to_recordings,
});

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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

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

  const routes = useQuery({
    queryKey: ['my', 'priorities', 'routes'],
    queryFn: async () => (await request<{ routes: Route[] }>('/client/routes')).routes,
    enabled: product === 'calls',
  });

  const requirements = useQuery({
    queryKey: ['my', 'call-requirements'],
    queryFn: async () =>
      (await request<{ requirements: CallRequirements }>('/client/call-requirements')).requirements,
    enabled: product === 'calls',
  });

  const save = useMutation({
    mutationFn: async (lists: {
      priorities: { aliasId: string; offer: string; priority: number | null }[];
      routes: { routeId: string; kind: string; priority: number | null }[] | undefined;
    }) => {
      await request<unknown>(`/client/partner-priorities?product=${product}`, {
        method: 'PUT',
        body: { priorities: lists.priorities },
      });
      if (lists.routes !== undefined) {
        await request<unknown>('/client/route-priorities', {
          method: 'PUT',
          body: { priorities: lists.routes },
        });
      }
    },
    onSuccess: async () => {
      setDraft(undefined);
      setPicked(new Set());
      await queryClient.invalidateQueries({ queryKey: ['my', 'priorities'] });
    },
  });

  const calls = product === 'calls';
  const loaded = offers.isSuccess && stored.isSuccess && (!calls || routes.isSuccess);
  const saved = useMemo(() => {
    const result: Record<string, string> = {};
    for (const row of stored.data ?? []) {
      result[keyOf({ aliasId: row.alias_id, offer: row.offer })] =
        row.priority === null ? BANNED : String(row.priority);
    }
    for (const route of routes.data ?? []) {
      if (route.configured) {
        result[routeKey(route)] = route.priority === null ? BANNED : String(route.priority);
      }
    }
    return result;
  }, [stored.data, routes.data]);
  const routesOf = useMemo(() => {
    const result = new Map<string, Route[]>();
    for (const route of routes.data ?? []) {
      const key = keyOf({ aliasId: route.alias_id, offer: route.kind });
      const own = result.get(key);
      if (own === undefined) result.set(key, [route]);
      else own.push(route);
    }
    return result;
  }, [routes.data]);
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
  const invalid = [
    ...all.filter((offer) => !isValid((values[keyOf(offer)] ?? '').trim())).map((o) => o.name),
    ...(routes.data ?? [])
      .filter((route) => !isValid((values[routeKey(route)] ?? '').trim()))
      .map(routeName),
  ];

  const change = (keys: Iterable<string>, value: string) => {
    const next = { ...values };
    for (const key of keys) {
      if (value === '') Reflect.deleteProperty(next, key);
      else next[key] = value;
    }
    setDraft(next);
  };

  const error = [offers.error, stored.error, routes.error, save.error, requirements.error].find(
    (e) => e instanceof ApiError,
  );
  const now = Date.now();
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
          aria-label="Найти маршрут"
          placeholder="Найти маршрут"
          className="w-[220px]"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <Hint label="Как работают приоритеты">
          <p>
            Очерёдность 1 — первыми, дальше 2, 3… Если у нескольких маршрутов одна очерёдность, они
            используются по очереди (сначала дешевле). Когда у маршрутов с очерёдностью 1 всё занято
            или исчерпаны лимиты, берутся маршруты с очерёдностью 2 и так далее.
          </p>
          <p className="mt-2">
            Пусто — маршрут идёт после всех названных. «Не использовать» — не берётся совсем. Для
            отдельной линии можно задать свой порядок в «Линии»: он главнее этого списка.
          </p>
          {calls && (
            <p className="mt-2">
              Стрелка у партнёра раскрывает его SIM или SIP по отдельности. Своя очерёдность SIM или
              SIP главнее очерёдности партнёра, и её «не использовать» тоже. Пусто — как у партнёра.
            </p>
          )}
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
              <TableHead className="h-8">Маршрут</TableHead>
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
                  {all.length === 0 ? 'Маршрутов пока нет.' : 'Никого не нашли: измените запрос.'}
                </TableCell>
              </TableRow>
            )}
            {shown.map((offer) => {
              const key = keyOf(offer);
              const value = values[key] ?? '';
              const own = routesOf.get(key) ?? [];
              const open = expanded.has(key);
              const Chevron = open ? ChevronDown : ChevronRight;
              return (
                <Fragment key={key}>
                  <TableRow>
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
                    <TableCell>
                      {own.length > 0 ? (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-left"
                          aria-expanded={open}
                          onClick={() => {
                            const next = new Set(expanded);
                            if (open) next.delete(key);
                            else next.add(key);
                            setExpanded(next);
                          }}
                        >
                          <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          {offer.name}
                          <span className="text-muted-foreground">
                            · {String(own.length)}{' '}
                            {offer.offer === 'message' ? '' : TERMINATION_KIND_NAME[offer.offer]}
                          </span>
                        </button>
                      ) : (
                        offer.name
                      )}
                    </TableCell>
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
                  {open &&
                    own.map((route) => (
                      <RouteRow
                        key={routeKey(route)}
                        route={route}
                        value={values[routeKey(route)] ?? ''}
                        inherited={value}
                        picked={picked.has(routeKey(route))}
                        fresh={
                          !route.configured && now - Date.parse(route.created_at) < NEW_ROUTE_MS
                        }
                        loaded={loaded}
                        requirements={requirements.data}
                        onPick={(checked) => {
                          const next = new Set(picked);
                          if (checked) next.add(routeKey(route));
                          else next.delete(routeKey(route));
                          setPicked(next);
                        }}
                        onChange={(next) => {
                          change([routeKey(route)], next);
                        }}
                      />
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {invalid.length > 0 && (
        <p className="text-warn">
          Очерёдность — целое число от 1 до {CLIENT_PRIORITY_MAX}. Исправьте: {invalid.join(', ')}.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!loaded || draft === undefined || invalid.length > 0 || save.isPending}
          onClick={() => {
            const entries = Object.entries(values).flatMap(([key, raw]) => {
              if (raw === '') return [];
              const parsed = raw === BANNED ? null : integerFromInput(raw);
              return parsed === undefined ? [] : [{ key, priority: parsed }];
            });
            save.mutate({
              priorities: entries
                .filter((entry) => !entry.key.startsWith('r:'))
                .map((entry) => {
                  const [aliasId = '', offer = ''] = entry.key.split(':');
                  return { aliasId, offer, priority: entry.priority };
                }),
              routes: calls
                ? entries
                    .filter((entry) => entry.key.startsWith('r:'))
                    .map((entry) => {
                      const [, kind = '', routeId = ''] = entry.key.split(':');
                      return { routeId, kind, priority: entry.priority };
                    })
                : undefined,
            });
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
        <span title="На части направлений цена выше вашего предела — туда звонки этим маршрутом не пойдут">
          <span className="text-ok">да</span>
          <span className="text-muted-foreground">, кроме дорогих направлений</span>
        </span>
      ) : (
        <span className="text-ok">да</span>
      )}
    </TableCell>
  );
}

/** Строка одной SIM или одного SIP-провайдера под строкой партнёра (ADR-0120). */
function RouteRow({
  route,
  value,
  inherited,
  picked,
  fresh,
  loaded,
  requirements,
  onPick,
  onChange,
}: {
  route: Route;
  value: string;
  /** Значение строки партнёра: пусто у маршрута — действует оно. */
  inherited: string;
  picked: boolean;
  fresh: boolean;
  loaded: boolean;
  requirements: CallRequirements | undefined;
  onPick: (checked: boolean) => void;
  onChange: (value: string) => void;
}) {
  const name = routeName(route);
  const banned = value === BANNED || (value === '' && inherited === BANNED);
  return (
    <TableRow className="bg-muted/30">
      <TableCell>
        <input
          type="checkbox"
          aria-label={`Выбрать ${name}`}
          checked={picked}
          onChange={(event) => {
            onPick(event.target.checked);
          }}
        />
      </TableCell>
      <TableCell className="pl-8">
        {TERMINATION_KIND_NAME[route.kind]} {String(route.number)}
        {fresh && <span className="ml-2 text-xs text-primary">новый</span>}
        {!route.available && (
          <span
            className="ml-2 text-xs text-muted-foreground"
            title="Партнёр выключил его или он не на связи: звонки через него сейчас не идут"
          >
            сейчас не звонит
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground" title={TERMINATION_KIND_MEANING[route.kind]}>
        {TERMINATION_KIND_NAME[route.kind]}
      </TableCell>
      <TableCell className="num text-right">
        {priceRange(route.min_price, route.max_price)}
      </TableCell>
      <TableCell>
        {route.listens_to_recordings ? (
          'слушает'
        ) : (
          <span className="text-muted-foreground">не слушает</span>
        )}
      </TableCell>
      <FitCell offer={routeAsOffer(route)} banned={banned} requirements={requirements} />
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Очерёдность: ${name}`}
            className="num w-[70px]"
            inputMode="numeric"
            autoComplete="off"
            placeholder={inherited === '' || inherited === BANNED ? '—' : inherited}
            title="Пусто — как у партнёра"
            disabled={!loaded || value === BANNED}
            value={value === BANNED ? '' : value}
            onChange={(event) => {
              onChange(event.target.value.trim());
            }}
          />
          <label className="flex items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              checked={value === BANNED}
              disabled={!loaded}
              onChange={(event) => {
                onChange(event.target.checked ? BANNED : '');
              }}
            />
            не использовать
          </label>
        </div>
      </TableCell>
    </TableRow>
  );
}
