'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { request } from '@/lib/api';

/**
 * Объявление о прослушивании записей ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
 *
 * Единственное действие партнёра над самим собой, и до сих пор оно делалось только
 * через `curl`. Цена решения названа прямо: признак виден клиенту в списке псевдонимов,
 * и клиент, которому это не подходит, поставит такого партнёра ниже.
 */
export function RecordingsAccess({ partnerId, listens }: { partnerId: string; listens: boolean }) {
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

  return (
    <div className="flex max-w-prose flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <h3 className="font-semibold">Записи разговоров</h3>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={listens}
          disabled={declare.isPending}
          onChange={(event) => {
            declare.mutate(event.target.checked);
          }}
          className="mt-1"
        />
        <span>
          Я слушаю записи разговоров, прошедших через моё оборудование.
          <span className="block text-muted-foreground">
            Это видно клиентам рядом с вашим псевдонимом. Клиент, которому это не подходит, поставит
            вас ниже в своём порядке — то есть отметка стоит трафика. Без неё записи вам не
            выдаются.
          </span>
        </span>
      </label>

      {declare.error !== null && (
        <p role="alert" className="text-crit">
          {declare.error.message}
        </p>
      )}
    </div>
  );
}
