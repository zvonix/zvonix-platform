'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PARTNER_STATUSES, type PartnerStatus } from '@zvonix/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AccountLedger } from '@/components/account-ledger';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
import { SipCredentials, type IssuedCredentials } from '@/components/sip-credentials';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { PARTNER_STATUS_MEANING, PARTNER_STATUS_NAME, partnerStatusTone } from '@/lib/labels';
import { isNegative, money } from '@/lib/money';
import { atMost } from '@/lib/wait';
import { PartnerEquipment } from '../partner-equipment';
import { PartnerRates } from '../partner-rates';
import { findPartner, type PartnerRow } from '../partner-row';

/** Кнопка называет действие, а не состояние, в которое переводит. */
const PARTNER_ACTION: Record<PartnerStatus, string> = {
  pending: 'Вернуть на проверку',
  verified: 'Допустить к работе',
  suspended: 'Приостановить',
  closed: 'Закрыть навсегда',
};

export default function PartnerCardPage() {
  const params = useParams<{ id: string }>();

  return (
    <ConsoleShell title="Партнёр" requireRole={['admin', 'support']}>
      {() => <PartnerCard id={params.id} />}
    </ConsoleShell>
  );
}

function BackLink() {
  return (
    <Link href="/partners" className="self-start text-primary underline-offset-4 hover:underline">
      ← Все партнёры
    </Link>
  );
}

/**
 * Карточка партнёра — всё, что раньше раскрывалось строкой таблицы, отдельной страницей
 * ([DESIGN.md](../../../../../../docs/DESIGN.md), «Окно, страница или панель»): разделов
 * много, строка для них была тесной и сдвигала список, а у страницы есть адрес, который
 * можно отправить.
 */
function PartnerCard({ id }: { id: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<readonly IssuedCredentials[]>([]);

  // Ключ под общим `['partners']`: действия здесь и заведение в списке обновляют оба экрана.
  const card = useQuery({
    queryKey: ['partners', 'card', id],
    queryFn: ({ signal }) => findPartner(id, signal),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['partners'] });
  };

  // Отказы действий показывает их окно: в общей строке ошибок они повторились бы
  // вторым сообщением.
  const setStatus = useMutation({
    mutationFn: (status: PartnerStatus) =>
      request<unknown>(`/partners/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => atMost(invalidate()),
  });

  const rename = useMutation({
    mutationFn: (displayName: string) =>
      request<unknown>(`/partners/${id}/alias`, { method: 'PUT', body: { displayName } }),
    onSuccess: () => atMost(invalidate()),
  });

  if (card.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  if (card.isError) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        {card.error instanceof ApiError ? (
          <ErrorNote error={card.error} />
        ) : (
          <p className="text-crit">Карточку партнёра загрузить не удалось.</p>
        )}
      </div>
    );
  }

  const partner = card.data;
  if (partner === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p>
          Такого партнёра нет. Возможно, ссылка неполная — найдите его в списке по имени или
          псевдониму.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{partner.name}</h2>
          <span className={`rounded-sm px-1.5 py-0.5 ${partnerStatusTone(partner.status)}`}>
            {PARTNER_STATUS_NAME[partner.status]}
          </span>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Псевдоним у клиента:</dt>
            {/*
              Псевдоним заводится вместе с партнёром, но его отсутствие прячут только
              тогда, когда не собираются чинить: без псевдонима клиент партнёра не увидит.
            */}
            <dd>{partner.display_name ?? <span className="text-crit">не задан</span>}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Причитается:</dt>
            {/*
              Остаток на счёте партнёра — это долг площадки перед ним: доля за вызовы
              начислена, выплата ещё не сделана. Минус означает обратное, и это разбор,
              а не штатное состояние.
            */}
            <dd className={isNegative(partner.balance) ? 'num text-crit' : 'num'}>
              {money(partner.balance)}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Слушает записи:</dt>
            <dd>{partner.listens_to_recordings ? 'да' : 'нет'}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Добавлен:</dt>
            <dd className="num">{moment(partner.created_at)}</dd>
          </div>
        </dl>
      </header>

      {!canChange && <ReadOnly what="партнёра, его оборудование и цены" />}

      {/*
        Выданный пароль SIP — здесь, наверху карточки, а не внутри раздела шлюзов: панель
        не должна зависеть от того, что раздел свернёт, перерисует или уберёт. Второго
        показа пароля не будет — закрывает панель только человек. Панелей может быть
        несколько: пароль второго шлюза не затирает незакрытый пароль первого.
      */}
      {issued.map((secret) => (
        <SipCredentials
          key={secret.account.username}
          account={secret.account}
          title={secret.title}
          onClose={() => {
            setIssued((list) => list.filter((item) => item !== secret));
          }}
        />
      ))}

      {canChange && (
        <>
          <AliasSection partner={partner} onRename={(name) => rename.mutateAsync(name)} />
          <StatusSection
            partner={partner}
            busy={setStatus.isPending}
            onStatus={(status) => setStatus.mutateAsync(status)}
          />
        </>
      )}

      <PartnerEquipment
        partnerId={partner.id}
        onIssued={(secret) => {
          setIssued((list) => [
            ...list,
            { ...secret, title: `${secret.title} — партнёр «${partner.name}»` },
          ]);
        }}
      />
      <PartnerRates partnerId={partner.id} />
      <AccountLedger source={`/partners/${partner.id}/entries`} account="partner" />
    </div>
  );
}

/**
 * Смена состояния партнёра.
 *
 * Последствие не косметическое: `verified` — единственное состояние, при котором шлюз
 * регистрируется, а SIM попадают в отбор. Допуск к работе — окном с объяснением; всё, что
 * трафик останавливает или необратимо, — через подтверждение с названным последствием
 * ([DESIGN.md](../../../../../../docs/DESIGN.md)). Раньше и «Закрыт» срабатывал с первого
 * нажатия (ui-review, 2026-09-14). Из `closed` вариантов нет вовсе: переход необратим,
 * и предлагать его обратно — обещать то, чего API не сделает.
 */
function StatusSection({
  partner,
  busy,
  onStatus,
}: {
  partner: PartnerRow;
  busy: boolean;
  onStatus: (status: PartnerStatus) => Promise<unknown>;
}) {
  if (partner.status === 'closed') {
    return (
      <p className="text-muted-foreground">
        Партнёр закрыт. Это состояние окончательное — вернуть его в работу нельзя, нужен новый
        партнёр.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">Состояние</h3>
      <p className="text-muted-foreground">
        Сейчас — {PARTNER_STATUS_NAME[partner.status].toLowerCase()}:{' '}
        {PARTNER_STATUS_MEANING[partner.status]} Смена попадает в журнал вместе с тем, что было до.
      </p>
      <div className="flex flex-wrap gap-2">
        {PARTNER_STATUSES.filter((status) => status !== partner.status).map((status) =>
          status === 'verified' ? (
            <FormDialog
              key={status}
              label={PARTNER_ACTION[status]}
              title={`${PARTNER_ACTION[status]}: партнёр «${partner.name}»`}
              variant="outline"
              disabled={busy}
            >
              <DialogForm submitLabel={PARTNER_ACTION[status]} onSubmit={() => onStatus(status)}>
                <p className="sm:col-span-2">{PARTNER_STATUS_MEANING[status]}</p>
              </DialogForm>
            </FormDialog>
          ) : (
            <ConfirmAction
              key={status}
              label={PARTNER_ACTION[status]}
              title={`${PARTNER_ACTION[status]}: партнёр «${partner.name}»`}
              consequence={<p>{PARTNER_STATUS_MEANING[status]}</p>}
              confirmLabel={PARTNER_ACTION[status]}
              disabled={busy}
              onConfirm={() => onStatus(status)}
            />
          ),
        )}
      </div>
    </section>
  );
}

/**
 * Псевдоним, под которым партнёра видит клиент
 * ([ADR-0014](../../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 *
 * Единственное, что клиент о партнёре вообще знает, и до появления обработчика
 * задавался только при заведении: опечатка оставалась навсегда и на глазах у всех
 * клиентов. Уникален на всю площадку — занятое имя отвергается с названной причиной.
 */
function AliasSection({
  partner,
  onRename,
}: {
  partner: PartnerRow;
  onRename: (displayName: string) => Promise<unknown>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">Псевдоним у клиента</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span>{partner.display_name ?? <span className="text-crit">не задан</span>}</span>
        <FormDialog
          label="Переименовать"
          title={`Псевдоним партнёра «${partner.name}»`}
          variant="outline"
        >
          <AliasForm current={partner.display_name ?? ''} onRename={onRename} />
        </FormDialog>
      </div>
    </section>
  );
}

function AliasForm({
  current,
  onRename,
}: {
  current: string;
  onRename: (displayName: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(current);
  const trimmed = value.trim();
  const dirty = trimmed.length >= 2 && trimmed !== current;

  return (
    <DialogForm submitLabel="Переименовать" canSubmit={dirty} onSubmit={() => onRename(trimmed)}>
      <DialogField
        label="Псевдоним у клиента"
        wide
        hint="Клиенты увидят новое имя сразу. Настоящее имя партнёра им не показывается никогда — псевдоним не должен на него намекать. Имя уникально на всю площадку."
      >
        <Input
          value={value}
          autoComplete="off"
          autoFocus
          placeholder="Партнёр 17"
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}
