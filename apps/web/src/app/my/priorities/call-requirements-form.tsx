'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, request } from '@/lib/api';
import { moneyFromInput, numberFromInput } from '@/lib/money';

export interface CallRequirements {
  readonly termination_kind: TerminationKind | null;
  readonly no_recording_listeners: boolean;
  readonly max_price: string | null;
}

const KIND_OPTIONS: readonly (readonly [TerminationKind | null, string])[] = [
  [null, 'Любой'],
  ['sim', 'Только SIM'],
  ['sip', 'Только SIP'],
];

/**
 * Требования клиента к партнёрам для звонков ([ADR-0095](../../../../../../docs/adr/0095-trebovaniya-klienta-k-partnyoram-zvonkov.md)):
 * задаются один раз, площадка соблюдает их при каждом вызове всех линий.
 */
export function CallRequirementsForm({ current }: { current: CallRequirements }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TerminationKind | null>(current.termination_kind);
  const [noListeners, setNoListeners] = useState(current.no_recording_listeners);
  const [price, setPrice] = useState(
    current.max_price === null ? '' : current.max_price.replace('.', ','),
  );
  const [saved, setSaved] = useState(false);
  // Сохранённое изменилось (другая вкладка) — поля показывают его.
  useEffect(() => {
    setKind(current.termination_kind);
    setNoListeners(current.no_recording_listeners);
    setPrice(current.max_price === null ? '' : current.max_price.replace('.', ','));
  }, [current]);

  const priceValid = price.trim() === '' || moneyFromInput(price) !== undefined;

  const save = useMutation({
    mutationFn: () =>
      request<unknown>('/client/call-requirements', {
        method: 'PUT',
        body: {
          terminationKind: kind,
          noRecordingListeners: noListeners,
          maxPrice: price.trim() === '' ? null : numberFromInput(price),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my', 'call-requirements'] });
      setSaved(true);
    },
  });

  const touch = () => {
    setSaved(false);
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Какие партнёры мне подходят</h2>
        <Hint label="Как работают требования">
          <p>
            Площадка берёт для ваших звонков только подходящих партнёров — при каждом вызове всех
            ваших линий. Новые партнёры, подходящие под требования, подключаются сами. Отдельного
            партнёра можно отключить в таблице ниже: «не использовать».
          </p>
          <p className="mt-2">
            Цена сравнивается по направлению вызова: партнёр, дешёвый на одного оператора и дорогой
            на другого, берётся только туда, где он не дороже вашего предела.
          </p>
        </Hint>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Через что</span>
          <div
            role="group"
            aria-label="Через что звонить"
            className="flex rounded-md border border-border p-0.5"
          >
            {KIND_OPTIONS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value);
                  touch();
                }}
                className={`rounded px-2.5 py-1 text-sm ${
                  kind === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex h-9 items-center gap-2">
          <Switch
            checked={noListeners}
            onCheckedChange={(next) => {
              setNoListeners(next);
              touch();
            }}
          />
          Только партнёры, которые не слушают записи
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-muted-foreground">
            Минута не дороже, ₽
            <Hint label="Что значит цена минуты">
              <p>
                Стоимость вызова в 60 секунд для вас — с платой за соединение и наценкой, та же, что
                в столбце «Цена за вызов».
              </p>
            </Hint>
          </span>
          <Input
            className="num w-32"
            inputMode="decimal"
            placeholder="без предела"
            aria-invalid={!priceValid}
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
              touch();
            }}
          />
        </label>
      </div>
      {save.error instanceof ApiError && <ErrorNote error={save.error} />}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!priceValid || save.isPending}
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
