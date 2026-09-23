'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isStaffRole, type ApplicationStatus, type Cabinet } from '@zvonix/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  ApplicationFields,
  EMPTY_APPLICATION,
  toApplication,
  type ApplicationDraft,
} from '@/components/application-fields';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { useCabinets } from '@/lib/cabinets';
import { moment } from '@/lib/format';
import { APPLICATION_STATUS_NAME, applicationTone, CABINET_KIND_NAME } from '@/lib/labels';

interface OwnApplication {
  readonly id: string;
  readonly cabinet: Cabinet;
  readonly status: ApplicationStatus;
  readonly created_at: string;
  readonly decision_note: string | null;
}

/**
 * Заявка на кабинет из уже открытого входа
 * ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)): служба такси
 * просит кабинет партнёра и наоборот. Анкета та же, что при регистрации. Здесь же —
 * свои заявки и решения по ним: отказ с причиной человек видит не только в письме.
 */
export default function ApplyPage() {
  return (
    <ConsoleShell title="Второй кабинет">
      {(user) =>
        isStaffRole(user.role) ? (
          <p role="alert" className="text-crit">
            У сотрудника площадки кабинетов не бывает: для кабинета клиента или партнёра нужна
            отдельная учётная запись.
          </p>
        ) : (
          <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
            <Apply />
          </Suspense>
        )
      }
    </ConsoleShell>
  );
}

function Apply() {
  const queryClient = useQueryClient();
  const wanted = useSearchParams().get('cabinet');
  const cabinets = useCabinets();
  const mine = useQuery({
    queryKey: ['me', 'applications'],
    queryFn: () => request<{ applications: OwnApplication[] }>('/me/applications'),
  });

  const owned = cabinets.data;
  const pending = new Set(
    (mine.data?.applications ?? [])
      .filter((application) => application.status === 'submitted')
      .map((application) => application.cabinet),
  );
  const available = (['client', 'partner'] as const).filter(
    (kind) => owned !== undefined && owned[kind] === null && !pending.has(kind),
  );
  const initial: Cabinet | undefined =
    wanted === 'client' || wanted === 'partner'
      ? available.includes(wanted)
        ? wanted
        : undefined
      : available[0];
  const [chosen, setChosen] = useState<Cabinet | undefined>(undefined);
  const cabinet = chosen ?? initial;
  const [draft, setDraft] = useState<ApplicationDraft>(EMPTY_APPLICATION);

  const submit = useMutation({
    mutationFn: (kind: Cabinet) =>
      request<unknown>('/me/applications', { method: 'POST', body: toApplication(kind, draft) }),
    onSuccess: async () => {
      setDraft(EMPTY_APPLICATION);
      setChosen(undefined);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/me/applications/${id}/withdraw`, { method: 'POST' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const error =
    submit.error instanceof ApiError
      ? submit.error
      : withdraw.error instanceof ApiError
        ? withdraw.error
        : undefined;

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      {mine.data !== undefined && mine.data.applications.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Ваши заявки</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
            {mine.data.applications.map((application) => (
              <li key={application.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="font-medium">{CABINET_KIND_NAME[application.cabinet]}</span>
                <span className={`rounded-sm px-1.5 py-0.5 ${applicationTone(application.status)}`}>
                  {APPLICATION_STATUS_NAME[application.status]}
                </span>
                <span className="num text-muted-foreground">{moment(application.created_at)}</span>
                {application.decision_note !== null && (
                  <span className="basis-full text-muted-foreground">
                    Причина отказа: {application.decision_note}
                  </span>
                )}
                {application.status === 'submitted' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    disabled={withdraw.isPending}
                    onClick={() => {
                      withdraw.mutate(application.id);
                    }}
                  >
                    Отозвать
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error !== undefined && <ErrorNote error={error} />}

      {owned !== undefined && cabinet === undefined && (
        <p className="text-muted-foreground">
          {owned.client !== null && owned.partner !== null
            ? 'Оба кабинета у вас уже подключены — переключатель в шапке.'
            : 'Заявка на недостающий кабинет уже ждёт решения администратора.'}
        </p>
      )}

      {cabinet !== undefined && (
        <form
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate(cabinet);
          }}
        >
          <h2 className="font-semibold">
            Заявка: {cabinet === 'partner' ? 'кабинет партнёра' : 'кабинет службы такси'}
          </h2>
          {available.length > 1 && (
            <div role="group" aria-label="Кабинет" className="flex gap-2">
              {available.map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={kind === cabinet ? 'default' : 'outline'}
                  aria-pressed={kind === cabinet}
                  onClick={() => {
                    setChosen(kind);
                  }}
                >
                  {CABINET_KIND_NAME[kind]}
                </Button>
              ))}
            </div>
          )}
          <p className="text-muted-foreground">
            Войдёте тем же логином, деньги учитываются отдельно от первого кабинета. Звонки ваших
            линий на ваши же SIM не пойдут.
          </p>
          <ApplicationFields cabinet={cabinet} value={draft} onChange={setDraft} />
          <Button type="submit" disabled={submit.isPending} className="self-start">
            {submit.isPending ? 'Отправляем…' : 'Отправить заявку'}
          </Button>
        </form>
      )}
    </div>
  );
}
