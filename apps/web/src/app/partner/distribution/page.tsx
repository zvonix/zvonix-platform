'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISTRIBUTION_MODES,
  DISTRIBUTION_RANK_MAX,
  DISTRIBUTION_RESERVE_MAX,
  type DistributionMode,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface Settings {
  readonly mode: DistributionMode;
  readonly reserve_percent: number;
  readonly quiet_from_minute: number | null;
  readonly quiet_to_minute: number | null;
  readonly timezone: string;
  readonly sticky_recipient: boolean;
}

interface RankedAccount {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly weight: number;
  readonly priority: number;
}

interface Distribution {
  readonly settings: Settings;
  readonly accounts: RankedAccount[];
}

const KEY = ['partner', 'distribution', 'messages'] as const;

/** Название режима и одна строка о том, как он выбирает следующий аккаунт. */
const MODE_TEXT: Record<DistributionMode, { name: string; note: string }> = {
  equal: { name: 'Поровну', note: 'Первым идёт аккаунт, который дольше всех не работал' },
  remaining: {
    name: 'По остатку лимита',
    note: 'Первым идёт тот, у кого больше всего осталось на сутки',
  },
  sequential: {
    name: 'По очереди',
    note: 'Один аккаунт до предела, потом следующий — по порядку в списке',
  },
  weighted: {
    name: 'По весам',
    note: 'Доля сообщений пропорциональна весу аккаунта, например 3 : 1',
  },
  priority: {
    name: 'По приоритету',
    note: 'Сначала аккаунты с меньшим номером; внутри одного номера — поровну',
  },
};

const ZONES: readonly (readonly [string, string])[] = [
  ['Europe/Kaliningrad', 'Калининград (МСК−1)'],
  ['Europe/Moscow', 'Москва (МСК)'],
  ['Europe/Samara', 'Самара (МСК+1)'],
  ['Asia/Yekaterinburg', 'Екатеринбург (МСК+2)'],
  ['Asia/Omsk', 'Омск (МСК+3)'],
  ['Asia/Krasnoyarsk', 'Красноярск (МСК+4)'],
  ['Asia/Irkutsk', 'Иркутск (МСК+5)'],
  ['Asia/Yakutsk', 'Якутск (МСК+6)'],
  ['Asia/Vladivostok', 'Владивосток (МСК+7)'],
  ['Asia/Magadan', 'Магадан (МСК+8)'],
  ['Asia/Kamchatka', 'Камчатка (МСК+9)'],
  ['UTC', 'UTC'],
];

const toTime = (minute: number | null): string =>
  minute === null
    ? ''
    : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const fromTime = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
};

export default function PartnerDistributionPage() {
  return (
    <ConsoleShell title="Распределение" cabinet="partner">
      {() => <DistributionView />}
    </ConsoleShell>
  );
}

/**
 * Как партнёр хочет распределять сообщения MAX между своими аккаунтами
 * ([ADR-0080](../../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)). Цена, приоритеты клиента и лимиты
 * площадки остаются первыми: настройка меняет порядок только внутри допустимых аккаунтов.
 */
function DistributionView() {
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<Distribution>('/partner/distribution/messages', { signal }),
  });
  if (query.error instanceof ApiError) return <ErrorNote error={query.error} />;
  if (query.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  // Форма заводится заново, когда с сервера пришли свежие значения: ключ — сохранённые настройки.
  return <Editor key={JSON.stringify(query.data.settings)} data={query.data} />;
}

function Editor({ data }: { data: Distribution }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<DistributionMode>(data.settings.mode);
  const [reserve, setReserve] = useState(String(data.settings.reserve_percent));
  const [quiet, setQuiet] = useState(data.settings.quiet_from_minute !== null);
  const [from, setFrom] = useState(toTime(data.settings.quiet_from_minute ?? 23 * 60));
  const [to, setTo] = useState(toTime(data.settings.quiet_to_minute ?? 7 * 60));
  const [zone, setZone] = useState(data.settings.timezone);
  const [sticky, setSticky] = useState(data.settings.sticky_recipient);

  const save = useMutation({
    mutationFn: () =>
      request<unknown>('/partner/distribution/messages', {
        method: 'PUT',
        body: {
          mode,
          reservePercent: Number(reserve === '' ? '0' : reserve),
          quietFromMinute: quiet ? fromTime(from) : null,
          quietToMinute: quiet ? fromTime(to) : null,
          timezone: zone,
          stickyRecipient: sticky,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const rank = useMutation({
    mutationFn: (input: { id: string; weight?: number; priority?: number }) =>
      request<unknown>(`/partner/messenger/accounts/${input.id}/distribution`, {
        method: 'PATCH',
        body: { weight: input.weight, priority: input.priority },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const reserveNumber = Number(reserve === '' ? '0' : reserve);
  const reserveValid =
    Number.isInteger(reserveNumber) &&
    reserveNumber >= 0 &&
    reserveNumber <= DISTRIBUTION_RESERVE_MAX;
  const quietValid = !quiet || (fromTime(from) !== null && fromTime(to) !== null && from !== to);
  const showWeight = mode === 'weighted';
  const showPriority = mode === 'priority' || mode === 'sequential';
  const error =
    save.error instanceof ApiError
      ? save.error
      : rank.error instanceof ApiError
        ? rank.error
        : undefined;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {error !== undefined && <ErrorNote error={error} />}

      <section aria-label="Режим" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1 font-semibold">
          Сообщения MAX: как выбирать аккаунт
          <Hint label="Что делает распределение">
            <p>
              Цена, приоритеты клиента и лимиты площадки остаются первыми. Здесь вы выбираете только
              порядок внутри ваших аккаунтов, которым можно отправлять прямо сейчас.
            </p>
          </Hint>
        </h2>
        <div role="radiogroup" aria-label="Режим распределения" className="flex flex-col gap-1">
          {DISTRIBUTION_MODES.map((value) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                mode === value ? 'border-primary bg-card' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name="mode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                }}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">{MODE_TEXT[value].name}</span>
                <span className="block text-muted-foreground">{MODE_TEXT[value].note}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section aria-label="Параметры" className="flex flex-col gap-3">
        <h2 className="font-semibold">Параметры</h2>

        <div className="flex flex-col gap-1">
          <Label htmlFor="reserve" className="flex items-center gap-1">
            Запас лимита, %
            <Hint label="Что такое запас лимита">
              <p>
                Не расходовать последнюю долю лимита: она остаётся на непредвиденное. 0 — без
                запаса.
              </p>
            </Hint>
          </Label>
          <Input
            id="reserve"
            inputMode="numeric"
            className="w-28"
            value={reserve}
            aria-invalid={!reserveValid}
            onChange={(event) => {
              setReserve(event.target.value.replace(/\D/gu, ''));
            }}
          />
          {!reserveValid && (
            <span className="text-crit">От 0 до {String(DISTRIBUTION_RESERVE_MAX)}</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-3">
            <Switch checked={quiet} onCheckedChange={setQuiet} aria-label="Тихие часы" />
            <span className="flex items-center gap-1">
              Тихие часы
              <Hint label="Что такое тихие часы">
                <p>
                  В это время аккаунты не отправляют: ночной отдых снижает риск блокировки.
                  Сообщения ждут утра или уходят через другой аккаунт.
                </p>
              </Hint>
            </span>
          </label>
          {quiet && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="quiet-from">С</Label>
                <Input
                  id="quiet-from"
                  type="time"
                  className="w-32"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="quiet-to">До</Label>
                <Input
                  id="quiet-to"
                  type="time"
                  className="w-32"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="quiet-zone">Часовой пояс</Label>
                <select
                  id="quiet-zone"
                  value={zone}
                  onChange={(event) => {
                    setZone(event.target.value);
                  }}
                  className="h-9 rounded-md border border-input bg-transparent px-2"
                >
                  {ZONES.map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                  {!ZONES.some(([value]) => value === zone) && <option value={zone}>{zone}</option>}
                </select>
              </div>
              {!quietValid && <span className="text-crit">Начало и конец должны отличаться</span>}
            </div>
          )}
        </div>

        <label className="flex items-center gap-3">
          <Switch
            checked={sticky}
            onCheckedChange={setSticky}
            aria-label="Один получатель — один аккаунт"
          />
          <span className="flex items-center gap-1">
            Один получатель — один аккаунт
            <Hint label="Зачем это нужно">
              <p>
                Повторные сообщения одному человеку идут с того же аккаунта. Переписка выглядит
                естественно, жалоб меньше — риск блокировки ниже.
              </p>
            </Hint>
          </span>
        </label>

        <div>
          <Button
            disabled={save.isPending || !reserveValid || !quietValid}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </section>

      {(showWeight || showPriority) && (
        <section aria-label="Аккаунты" className="flex flex-col gap-2">
          <h2 className="font-semibold">{showWeight ? 'Вес аккаунтов' : 'Порядок аккаунтов'}</h2>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Аккаунт</TableHead>
                  <TableHead className="h-8 text-right">
                    {showWeight ? 'Вес' : 'Номер в списке'}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accounts.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={2} className="text-muted-foreground">
                      Аккаунтов нет.
                    </TableCell>
                  </TableRow>
                )}
                {data.accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell>{account.label}</TableCell>
                    <TableCell className="text-right">
                      <RankInput
                        label={`${showWeight ? 'Вес' : 'Номер в списке'} аккаунта «${account.label}»`}
                        value={showWeight ? account.weight : account.priority}
                        onCommit={(value) => {
                          rank.mutate({
                            id: account.id,
                            ...(showWeight ? { weight: value } : { priority: value }),
                          });
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}

/** Число от 1 до предела: отправляется, когда поле теряет фокус или нажат Enter, а не на каждую цифру. */
function RankInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const next = Number(text);
    if (Number.isInteger(next) && next >= 1 && next <= DISTRIBUTION_RANK_MAX) {
      if (next !== value) onCommit(next);
    } else {
      setText(String(value));
    }
  };
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      className="ml-auto w-20 text-right"
      value={text}
      onChange={(event) => {
        setText(event.target.value.replace(/\D/gu, ''));
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}
