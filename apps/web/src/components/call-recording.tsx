'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { FormDialog } from '@/components/form-dialog';
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
 * «Прослушать»: окно с плеером. Ссылку на запись (с записью в журнал, ADR-0036) окно берёт
 * при открытии, а не заранее: она живёт короткое время, и каждое открытие — новое прослушивание
 * в журнале. Закрытие окна убирает плеер вместе со звуком.
 *
 * `subtitle` — что за разговор («79230189196 · 4 октября, 17:38»): в окне записей не перепутать.
 */
export function ListenButton({
  recordingId,
  subtitle,
}: {
  recordingId: string;
  subtitle?: string;
}) {
  return (
    <FormDialog
      label="Прослушать"
      title="Запись разговора"
      variant="outline"
      size="xs"
      {...(subtitle === undefined ? {} : { description: subtitle })}
    >
      <Player recordingId={recordingId} />
    </FormDialog>
  );
}

function Player({ recordingId }: { recordingId: string }) {
  const link = useMutation({
    mutationFn: () =>
      request<{ url: string }>(`/recordings/${recordingId}/link`, { method: 'POST' }),
  });
  const { mutate } = link;

  // Окно монтирует содержимое открытым: ссылка берётся ровно один раз за открытие.
  useEffect(() => {
    mutate();
  }, [mutate]);

  return (
    <div className="flex flex-col gap-3 px-5 pb-5">
      {link.isPending && <p className="text-muted-foreground">Открываем запись…</p>}
      {link.error !== null && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-crit">{link.error.message}</p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                mutate();
              }}
            >
              Повторить
            </Button>
          </div>
        </div>
      )}
      {link.data !== undefined && (
        <>
          <audio
            controls
            autoPlay
            src={link.data.url}
            className="h-12 w-full"
            aria-label="Запись разговора"
          />
          <p className="text-muted-foreground">
            Прослушивание записывается в журнал. Ссылка действует недолго — при следующем открытии
            окна выдаётся новая.
          </p>
        </>
      )}
    </div>
  );
}
