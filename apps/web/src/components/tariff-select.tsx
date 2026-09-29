'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { usePartnerRates } from '@/lib/tariffs';

/**
 * Выбор тарифа у шлюза или карты ([ADR-0056](../../../../docs/adr/0056-tarify-partnyora.md)).
 *
 * Сохраняется сразу при выборе: одно поле, и кнопка «Сохранить» рядом с ним была бы
 * лишним шагом. Пустое значение — «наследовать»: у карты — тариф шлюза, у шлюза —
 * тариф по умолчанию. Какой именно наследуется, подписано в самом пункте.
 */
export function TariffSelect({
  value,
  inherited,
  endpoint,
  label,
  invalidate,
}: {
  /** Выбранный тариф; пусто — наследуется. */
  value: string | null;
  /** Подпись пункта «наследовать», например «как у шлюза — Основной». */
  inherited: string;
  /** `POST` с телом `{ tariffId }`. */
  endpoint: string;
  /** Подпись для чтения с экрана: тариф чего выбирается. */
  label: string;
  /** Ключи кэша, которые меняются вместе с тарифом. */
  invalidate: readonly (readonly string[])[];
}) {
  const queryClient = useQueryClient();
  const rates = usePartnerRates();

  const save = useMutation({
    mutationFn: (tariffId: string | null) =>
      request<unknown>(endpoint, { method: 'POST', body: { tariffId } }),
    onSuccess: () =>
      Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });

  const tariffs = rates.data?.tariffs ?? [];
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={label}
        value={value ?? ''}
        disabled={save.isPending || rates.isPending}
        onChange={(event) => {
          save.mutate(event.target.value === '' ? null : event.target.value);
        }}
        className="h-8 max-w-[16rem] rounded-md border border-input bg-transparent px-2"
      >
        {/*
          Пока тарифы не пришли, выбранный нечем назвать, и пустой пункт показал бы
          «наследовать» у карты, у которой свой тариф.
        */}
        {rates.isPending ? (
          <option value={value ?? ''}>загружаем…</option>
        ) : (
          <option value="">{inherited}</option>
        )}
        {tariffs.map((tariff) => (
          <option key={tariff.id} value={tariff.id}>
            {tariff.name}
          </option>
        ))}
      </select>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Имя тарифа по идентификатору; пусто — тариф по умолчанию. */
export function useTariffName(): (id: string | null) => string | undefined {
  const rates = usePartnerRates();
  return (id) => {
    const tariffs = rates.data?.tariffs ?? [];
    const tariff =
      id === null ? tariffs.find((row) => row.is_default) : tariffs.find((row) => row.id === id);
    return tariff?.name;
  };
}
