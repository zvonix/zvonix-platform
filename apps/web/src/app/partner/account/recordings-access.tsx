'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Hint } from '@/components/hint';
import { Switch } from '@/components/ui/switch';
import { request } from '@/lib/api';

/**
 * Объявление о прослушивании записей ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
 *
 * Единственное действие партнёра над самим собой, и до сих пор оно делалось только
 * через `curl`. Цена решения названа прямо: признак виден клиенту в списке псевдонимов,
 * и клиент, которому это не подходит, поставит такого партнёра ниже.
 */
export function RecordingsAccess({
  partnerId,
  listens,
  alias,
}: {
  partnerId: string;
  listens: boolean;
  alias: string | null;
}) {
  const queryClient = useQueryClient();

  const declare = useMutation({
    mutationFn: (next: boolean) =>
      request<{ partner: { listens_to_recordings: boolean } }>(
        `/partners/${partnerId}/recordings-access`,
        { method: 'PUT', body: { listens: next } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['partner', 'account'] });
    },
  });

  // Всё, что о партнёре видит клиент, — одной карточкой: псевдоним и отметка о записях (осмотр 2026-10-21).
  return (
    <section className="flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Что видят клиенты</h2>
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Псевдоним</span>
        <span>{alias ?? <span className="text-faint">не задан</span>}</span>
      </div>
      <label className="flex items-center gap-2">
        <Switch
          checked={listens}
          disabled={declare.isPending}
          onCheckedChange={(next) => {
            declare.mutate(next);
          }}
        />
        Я слушаю записи разговоров
        <Hint label="Про записи разговоров">
          <p>
            Отметка видна клиентам рядом с вашим псевдонимом. Клиент, которому это не подходит,
            поставит вас ниже в своём порядке — то есть отметка стоит трафика. Без неё записи вам не
            выдаются.
          </p>
        </Hint>
      </label>
      {declare.error !== null && (
        <p role="alert" className="text-crit">
          {declare.error.message}
        </p>
      )}
    </section>
  );
}
