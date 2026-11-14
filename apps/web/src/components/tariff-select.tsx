'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { TERMINATION_KIND_NAME } from '@/lib/labels';
import { tariffOfRate, usePartnerRates } from '@/lib/tariffs';

/**
 * Выбор тарифа у шлюза, карты или SIP-провайдера ([ADR-0056](../../../../docs/adr/0056-tarify-partnyora.md)).
 *
 * Сохраняется сразу при выборе: одно поле, и кнопка «Сохранить» рядом с ним была бы лишним шагом. Пустое значение —
 * «наследовать»: у карты — тариф шлюза, у шлюза и провайдера — тариф по умолчанию.
 *
 * В поле — только название тарифа (владелец, 2026-11-14: «зачем „как у шлюза — Основной“»); откуда он, — в подсказке.
 * Тариф без цен нужного способа выбрать нельзя: у SIP-провайдера тариф с ценами только «через SIM» не дал бы ему ни
 * одного звонка (владелец: «в тарифе только SIM — какого выбор тарифа у SIP»). Такой пункт виден, но недоступен, и
 * подписан «нет цен SIP».
 */
export function TariffSelect({
  value,
  inheritedId,
  inheritedFrom,
  kind,
  endpoint,
  label,
  invalidate,
}: {
  /** Выбранный тариф; пусто — наследуется. */
  value: string | null;
  /** Наследуемый тариф; пусто — тариф по умолчанию. */
  inheritedId: string | null;
  /** Откуда он наследуется — для подсказки: «тариф шлюза», «тариф по умолчанию». */
  inheritedFrom: string;
  /** Чем звонит то, чему выбирается тариф: цены этого способа в тарифе обязательны. */
  kind: TerminationKind;
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
  const priced = new Set(
    (rates.data?.rates ?? [])
      .filter((rate) => rate.termination_kind === kind)
      .map((rate) => tariffOfRate(rate, tariffs)),
  );
  const inherited =
    inheritedId === null
      ? tariffs.find((tariff) => tariff.is_default)
      : tariffs.find((tariff) => tariff.id === inheritedId);
  const missing = ` — нет цен ${TERMINATION_KIND_NAME[kind]}`;
  const nameOf = (tariff: { id: string; name: string }): string =>
    priced.has(tariff.id) ? tariff.name : `${tariff.name}${missing}`;
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={label}
        title={value === null ? `${inheritedFrom}: ${inherited?.name ?? '—'}` : undefined}
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
          <option value="">{inherited === undefined ? inheritedFrom : nameOf(inherited)}</option>
        )}
        {tariffs
          // Наследуемый тариф уже стоит первым пунктом — второй с тем же названием только путал бы.
          .filter((tariff) => tariff.id === value || tariff.id !== inherited?.id)
          .map((tariff) => (
            <option
              key={tariff.id}
              value={tariff.id}
              // Выбранный остаётся доступным, чтобы поле показывало правду; новый без цен не выбрать.
              disabled={!priced.has(tariff.id) && tariff.id !== value}
            >
              {nameOf(tariff)}
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
