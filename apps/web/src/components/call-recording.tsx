'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { request } from '@/lib/api';

interface Listenable {
  readonly call_id: string;
  readonly recording_id: string;
}

/**
 * У каких вызовов страницы есть запись, которую можно послушать (ADR-0063).
 *
 * Один запрос на страницу списка. Сервер сам отбирает записи по праву смотрящего: клиент
 * получит свои, партнёр — по ADR-0036, сотрудник — все, поэтому кнопка не обещает того,
 * в чём откажут. Возвращает `идентификатор вызова → идентификатор записи`.
 */
export function useListenable(callIds: readonly string[]): ReadonlyMap<string, string> {
  const ids = callIds.join(',');
  const found = useQuery({
    queryKey: ['recordings', 'available', ids],
    enabled: ids !== '',
    // Запись появляется через полминуты после разговора: новую страницу нет смысла
    // перечитывать при каждом возврате на неё, но и держать устаревшую долго не нужно.
    staleTime: 30_000,
    queryFn: () =>
      request<{ recordings: Listenable[] }>(`/recordings/available?callIds=${ids}`).then(
        (body) => body.recordings,
      ),
  });
  return new Map((found.data ?? []).map((row) => [row.call_id, row.recording_id]));
}

/**
 * «Прослушать»: берёт у площадки ссылку на запись (с записью в журнал, ADR-0036) и
 * показывает плеер. Ссылка живёт короткое время, поэтому берётся по нажатию, а не заранее.
 */
export function ListenButton({ recordingId }: { recordingId: string }) {
  const link = useMutation({
    mutationFn: () =>
      request<{ url: string }>(`/recordings/${recordingId}/link`, { method: 'POST' }),
  });

  if (link.data !== undefined) {
    return (
      <audio
        controls
        autoPlay
        src={link.data.url}
        className="mt-1 h-8 w-[220px] max-w-full"
        aria-label="Запись разговора"
      />
    );
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="xs"
        disabled={link.isPending}
        onClick={() => {
          link.mutate();
        }}
      >
        {link.isPending ? 'Открываем…' : 'Прослушать'}
      </Button>
      {link.error !== null && (
        <span role="alert" className="text-crit">
          {link.error.message}
        </span>
      )}
    </span>
  );
}
