'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { money, moneyFromInput, numberFromInput } from '@/lib/money';
import { Priorities } from '../priorities/priorities-view';

type StopRequirement = 'any' | 'required' | 'forbidden';

interface Requirements {
  readonly stop_line: StopRequirement;
  readonly recommended_only: boolean;
  readonly max_price: string | null;
  readonly min_age_days: number | null;
}

interface Offer {
  readonly id: string;
  readonly partner: string;
  readonly number: number;
  readonly price: string;
  readonly stop_line: boolean;
  readonly recommended: boolean;
  readonly age_days: number;
  readonly excluded: boolean;
  readonly reasons: string[];
}

interface Answer {
  readonly enabled: boolean;
  readonly requirements: Requirements;
  readonly accounts: Offer[];
}

const KEY = ['client', 'messages', 'accounts'] as const;

const STOP_OPTIONS: readonly (readonly [StopRequirement, string])[] = [
  ['any', 'Не важно'],
  ['required', 'Только со «СТОП»'],
  ['forbidden', 'Только без'],
];

export default function MyMaxAccountsPage() {
  return (
    <ConsoleShell title="Маршруты MAX" cabinet="client">
      {/* Раскладка — как у «Маршрутов звонков»: требования, затем маршруты с очерёдностью; без вкладок. У MAX ниже ещё
          аккаунты — маршрут здесь распадается на них (владелец, 2026-10-23: «примерно всё одно и то же»). */}
      {() => <Accounts routes={<Priorities product="messages" />} />}
    </ConsoleShell>
  );
}

/**
 * Какие аккаунты партнёров подходят клиенту ([ADR-0092](../../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)):
 * требования сверху — один раз, площадка соблюдает их при каждом выборе; ниже — все рабочие аккаунты под псевдонимами, с
 * причиной «не подходит» и ручным отключением. Подходящие — первыми.
 */
function Accounts({ routes }: { routes: React.ReactNode }) {
  const queryClient = useQueryClient();
  const answer = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<Answer>('/client/messages/accounts', { signal }),
  });

  const exclusion = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) =>
      request<unknown>(`/client/messages/accounts/${id}/exclusion`, {
        method: 'PUT',
        body: { excluded },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (answer.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {answer.error.message}
      </p>
    );
  }
  if (answer.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  const { requirements, accounts, enabled } = answer.data;
  if (!enabled) {
    return <p className="text-muted-foreground">Сообщения MAX на площадке пока выключены.</p>;
  }

  const fits = (offer: Offer): boolean => offer.reasons.length === 0 && !offer.excluded;
  const sorted = [...accounts].sort((left, right) => Number(fits(right)) - Number(fits(left)));
  const fitting = accounts.filter(fits).length;

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <RequirementsForm current={requirements} />

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Маршруты</h2>
        {routes}
      </section>

      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-semibold">Аккаунты</h2>
        <span
          className={fitting === 0 && accounts.length > 0 ? 'text-warn' : 'text-muted-foreground'}
        >
          подходят {String(fitting)} из {String(accounts.length)}
        </span>
        {fitting === 0 && accounts.length > 0 && (
          <span className="text-warn">— сообщения не уйдут, пока вы не смягчите требования</span>
        )}
      </div>
      {exclusion.error instanceof ApiError && <ErrorNote error={exclusion.error} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8">Маршрут</TableHead>
              <TableHead className="h-8">Аккаунт</TableHead>
              <TableHead className="h-8 text-right">Цена</TableHead>
              <TableHead className="h-8">«СТОП»</TableHead>
              <TableHead className="h-8">Рекомендованная работа</TableHead>
              <TableHead className="h-8 text-right">Работает</TableHead>
              <TableHead className="h-8">Подходит</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground">
                  Рабочих аккаунтов пока нет.
                </TableCell>
              </TableRow>
            )}
            {sorted.map((offer) => (
              <TableRow key={offer.id} className={fits(offer) ? undefined : 'opacity-70'}>
                <TableCell>{offer.partner}</TableCell>
                <TableCell>аккаунт {String(offer.number)}</TableCell>
                <TableCell className="num text-right">{money(offer.price)}</TableCell>
                <TableCell>
                  {offer.stop_line ? 'есть' : <span className="text-muted-foreground">нет</span>}
                </TableCell>
                <TableCell>
                  {offer.recommended ? 'да' : <span className="text-muted-foreground">нет</span>}
                </TableCell>
                <TableCell className="num text-right">{String(offer.age_days)} сут</TableCell>
                <TableCell className="whitespace-normal">
                  {offer.excluded ? (
                    <span className="text-muted-foreground">отключён вами</span>
                  ) : offer.reasons.length === 0 ? (
                    <span className="text-ok">да</span>
                  ) : (
                    <span className="text-warn">нет: {offer.reasons.join(', ')}</span>
                  )}
                </TableCell>
                <TableCell className="w-px">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={exclusion.isPending}
                    onClick={() => {
                      exclusion.mutate({ id: offer.id, excluded: !offer.excluded });
                    }}
                  >
                    {offer.excluded ? 'Вернуть' : 'Отключить'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RequirementsForm({ current }: { current: Requirements }) {
  const queryClient = useQueryClient();
  const [stop, setStop] = useState<StopRequirement>(current.stop_line);
  const [recommended, setRecommended] = useState(current.recommended_only);
  const [price, setPrice] = useState(
    current.max_price === null ? '' : current.max_price.replace('.', ','),
  );
  const [age, setAge] = useState(current.min_age_days === null ? '' : String(current.min_age_days));
  const [saved, setSaved] = useState(false);
  // Сохранённое изменилось (другая вкладка) — поля показывают его.
  useEffect(() => {
    setStop(current.stop_line);
    setRecommended(current.recommended_only);
    setPrice(current.max_price === null ? '' : current.max_price.replace('.', ','));
    setAge(current.min_age_days === null ? '' : String(current.min_age_days));
  }, [current]);

  const priceText = numberFromInput(price);
  const priceValid = price.trim() === '' || moneyFromInput(price) !== undefined;
  const ageValid = age.trim() === '' || /^\d{1,3}$/u.test(age.trim());

  const save = useMutation({
    mutationFn: () =>
      request<unknown>('/client/messages/requirements', {
        method: 'PUT',
        body: {
          stopLine: stop,
          recommendedOnly: recommended,
          maxPrice: price.trim() === '' ? null : priceText,
          minAgeDays: age.trim() === '' ? null : Number(age.trim()),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEY });
      setSaved(true);
    },
  });

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Какие аккаунты мне подходят</h2>
        <Hint label="Как работают требования">
          <p>
            Площадка берёт для ваших сообщений только подходящие аккаунты — при каждой отправке.
            Новые аккаунты партнёров, подходящие под требования, подключаются сами. Отдельный
            аккаунт можно отключить в таблице ниже.
          </p>
        </Hint>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-muted-foreground">
            Строка «СТОП»
            <Hint label="Про строку «СТОП»">
              <p>
                Партнёр сам решает, добавлять ли к сообщению строку «Чтобы отписаться, ответьте
                СТОП». Со строкой меньше жалоб, но сообщение длиннее.
              </p>
            </Hint>
          </span>
          <div
            role="group"
            aria-label="Строка «СТОП»"
            className="flex rounded-md border border-border p-0.5"
          >
            {STOP_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={stop === value}
                onClick={() => {
                  setStop(value);
                  setSaved(false);
                }}
                className={`rounded px-2.5 py-1 text-sm ${
                  stop === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex h-9 items-center gap-2">
          <Switch
            checked={recommended}
            onCheckedChange={(next) => {
              setRecommended(next);
              setSaved(false);
            }}
          />
          Только с рекомендованной работой
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Цена не дороже, ₽</span>
          <Input
            className="num w-32"
            inputMode="decimal"
            placeholder="без предела"
            aria-invalid={!priceValid}
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Работает не меньше, суток</span>
          <Input
            className="num w-32"
            inputMode="numeric"
            placeholder="не важно"
            aria-invalid={!ageValid}
            value={age}
            onChange={(event) => {
              setAge(event.target.value);
              setSaved(false);
            }}
          />
        </label>
      </div>
      {save.error instanceof ApiError && <ErrorNote error={save.error} />}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!priceValid || !ageValid || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить требования'}
        </Button>
        {saved && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
      </div>
    </section>
  );
}
