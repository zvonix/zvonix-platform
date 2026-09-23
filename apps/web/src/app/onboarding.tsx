'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ApplicationStatus, Cabinet } from '@zvonix/shared';
import Link from 'next/link';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import type { CurrentUser } from '@/lib/session';

interface OwnApplication {
  readonly id: string;
  readonly cabinet: Cabinet;
  readonly status: ApplicationStatus;
  readonly created_at: string;
  readonly decision_note: string | null;
}

const GENITIVE: Record<Cabinet, string> = { client: 'клиента', partner: 'партнёра' };

/** Что человек сделает в кабинете, когда его откроют: зачем он вообще ждёт. */
const WHAT_NEXT: Record<Cabinet, string> = {
  partner:
    'В «Моём оборудовании» заведёте шлюз GOIP и SIM-карты и получите данные для настройки шлюза, в «Моих ценах» — назначите цену за минуту по направлениям, которые откроет площадка. Звонки пойдут после проверки оборудования администратором.',
  client:
    'В «Моих линиях» увидите SIP-подключения диспетчерской, в «Интеграции» — ключи для своей системы, в «Деньгах» — остаток и пополнения.',
};

/**
 * Экран участника, у которого ещё нет кабинета.
 *
 * Раньше здесь стояла одна фраза «кабинетов пока нет» — и человек, только что подавший
 * заявку, не знал, ждать ли, что-то сделать самому или написать кому-то (владелец,
 * 2026-09-23). Теперь экран говорит, где заявка, что осталось сделать ему самому
 * (подтвердить адрес) и что будет в кабинете после одобрения.
 */
export function Onboarding({ user }: { user: CurrentUser }) {
  const mine = useQuery({
    queryKey: ['me', 'applications'],
    queryFn: () => request<{ applications: OwnApplication[] }>('/me/applications'),
  });

  if (mine.isPending) return <p className="text-muted-foreground">Загружаем заявку…</p>;
  if (mine.error !== null) {
    return mine.error instanceof ApiError ? (
      <ErrorNote error={mine.error} />
    ) : (
      <p role="alert">{mine.error.message}</p>
    );
  }

  const waiting = mine.data.applications.filter(
    (application) => application.status === 'submitted',
  );
  const rejected = mine.data.applications.find((application) => application.status === 'rejected');

  if (waiting.length === 0) {
    return (
      <section className="flex max-w-[640px] flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-base font-semibold">Кабинет ещё не подключён</h2>
        {rejected !== undefined && (
          <p role="status" className="text-crit">
            Заявка на кабинет {GENITIVE[rejected.cabinet]} от{' '}
            <span className="num">{moment(rejected.created_at)}</span> отклонена
            {rejected.decision_note === null ? '.' : `: ${rejected.decision_note}`}
          </p>
        )}
        <p>
          Кабинет клиента или партнёра открывается заявкой — её проверяет администратор площадки.
        </p>
        <Button asChild size="sm" className="self-start">
          <Link href="/apply">Подать заявку</Link>
        </Button>
      </section>
    );
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      {waiting.map((application) => (
        <section
          key={application.id}
          aria-labelledby={`application-${application.id}`}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        >
          <h2 id={`application-${application.id}`} className="text-base font-semibold">
            Заявка на кабинет {GENITIVE[application.cabinet]} на проверке
          </h2>
          <p className="text-muted-foreground">
            Отправлена <span className="num">{moment(application.created_at)}</span>.
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              <EmailStep user={user} />
            </li>
            <li>
              Администратор площадки проверит заявку и откроет кабинет — на <b>{user.email}</b>{' '}
              придёт письмо.
            </li>
            <li>{WHAT_NEXT[application.cabinet]}</li>
          </ol>
        </section>
      ))}
    </div>
  );
}

/**
 * Первый шаг — его делает сам человек: без подтверждённого адреса администратор заявку
 * одобрить не может ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 */
function EmailStep({ user }: { user: CurrentUser }) {
  const resend = useMutation({
    mutationFn: () => request<undefined>('/auth/email/resend', { method: 'POST' }),
  });

  if (user.email_confirmed_at !== null) {
    return <span>Адрес {user.email} подтверждён — с вашей стороны всё готово.</span>;
  }

  const error = resend.error instanceof ApiError ? resend.error : undefined;
  return (
    <span className="flex flex-col gap-2">
      <span>
        <b>Подтвердите адрес</b> по ссылке из письма, которое пришло на {user.email}: без этого
        заявку не одобрить.
      </span>
      {resend.isSuccess ? (
        <span role="status" className="text-ok">
          Письмо отправлено ещё раз. Проверьте и папку «Спам».
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={resend.isPending}
          onClick={() => {
            resend.mutate();
          }}
        >
          {resend.isPending ? 'Отправляем…' : 'Прислать письмо ещё раз'}
        </Button>
      )}
      {error !== undefined && <ErrorNote error={error} />}
    </span>
  );
}
