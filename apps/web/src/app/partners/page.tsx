'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PARTNER_STATUSES, type PartnerStatus } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { AccountLedger } from '@/components/account-ledger';
import { Choice } from '@/components/choice';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReadOnly } from '@/components/read-only';
import { SipCredentials, type IssuedCredentials } from '@/components/sip-credentials';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { moment } from '@/lib/format';
import { PARTNER_STATUS_MEANING, PARTNER_STATUS_NAME, partnerStatusTone } from '@/lib/labels';
import { isNegative, money } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import { NewPartnerForm } from './new-partner-form';
import { PartnerEquipment } from './partner-equipment';
import { PartnerRates } from './partner-rates';

const PAGE_SIZE = 50;
const COLUMNS = 7;

/** Кнопка называет действие, а не состояние, в которое переводит. */
const PARTNER_ACTION: Record<PartnerStatus, string> = {
  pending: 'Вернуть на проверку',
  verified: 'Допустить к работе',
  suspended: 'Приостановить',
  closed: 'Закрыть навсегда',
};

interface PartnerRow {
  readonly id: string;
  /** Настоящее имя. В клиентский контур не попадает: этот экран административный. */
  readonly name: string;
  readonly display_name: string | null;
  readonly status: PartnerStatus;
  readonly listens_to_recordings: boolean;
  readonly balance: string;
  readonly created_at: string;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

export default function PartnersPage() {
  return (
    <ConsoleShell title="Партнёры и оборудование" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <PartnersTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function PartnersTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [issued, setIssued] = useState<readonly IssuedCredentials[]>([]);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['partners', search.toString()],
    queryFn: () =>
      request<{ partners: PartnerRow[]; total: number }>(`/partners?${search.toString()}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['partners'] });
  };

  const verify = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/partners/${id}/status`, {
        method: 'PATCH',
        body: { status: 'verified' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемый перевод — своей мутацией: отказ виден в окне подтверждения.
  const confirmStatus = useMutation({
    mutationFn: (input: { id: string; status: PartnerStatus }) =>
      request<unknown>(`/partners/${input.id}/status`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; displayName: string }) =>
      request<unknown>(`/partners/${input.id}/alias`, {
        method: 'PUT',
        body: { displayName: input.displayName },
      }),
    onSuccess: invalidate,
  });

  const error = asApiError(verify.error ?? rename.error);
  const listError = asApiError(list.error);

  return (
    <div className="flex flex-col gap-3">
      {canChange ? <NewPartnerForm /> : <ReadOnly what="партнёров, их оборудование и цены" />}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Имя или псевдоним</span>
          <FilterInput
            className="w-[240px]"
            placeholder="часть имени"
            value={url.get('name')}
            onChange={(name) => {
              url.set({ name, offset: '' });
            }}
          />
        </label>

        <Choice
          label="Состояние"
          anyLabel="любое"
          value={url.get('status')}
          options={PARTNER_STATUSES.map((status) => [status, PARTNER_STATUS_NAME[status]])}
          onChange={(value) => {
            url.set({ status: value, offset: '' });
          }}
        />

        <div className="ml-auto">
          <PageNav
            offset={offset}
            limit={PAGE_SIZE}
            total={list.data?.total ?? 0}
            onChange={(next) => {
              url.set({ offset: next === 0 ? '' : String(next) });
            }}
          />
        </div>
      </div>

      {error !== undefined && <ErrorNote error={error} />}
      {listError !== undefined && <ErrorNote error={listError} />}

      {/*
        Выданный пароль SIP — здесь, над таблицей, а не в строке партнёра: строку сворачивают,
        открывают соседнюю, меняют страницу, и панель пропадала вместе с ней. Второго показа
        пароля не будет — закрывает панель только человек. Панелей может быть несколько:
        пароль второго шлюза не затирает незакрытый пароль первого.
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

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Имя</TableHead>
              <TableHead className="h-8">Псевдоним у клиента</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Причитается</TableHead>
              <TableHead className="h-8">Слушает записи</TableHead>
              <TableHead className="h-8">Заведён</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.partners.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору партнёров нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.partners.map((partner) => (
              <PartnerRows
                key={partner.id}
                partner={partner}
                open={opened === partner.id}
                busy={verify.isPending || confirmStatus.isPending}
                renaming={rename.isPending}
                onToggle={() => {
                  setOpened(opened === partner.id ? undefined : partner.id);
                }}
                onVerify={() => {
                  verify.mutate(partner.id);
                }}
                onConfirmStatus={(status) => confirmStatus.mutateAsync({ id: partner.id, status })}
                onRename={(displayName) => {
                  rename.mutate({ id: partner.id, displayName });
                }}
                onIssued={(secret) => {
                  setIssued((list) => [...list, secret]);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PartnerRows({
  partner,
  open,
  busy,
  renaming,
  onToggle,
  onVerify,
  onConfirmStatus,
  onRename,
  onIssued,
}: {
  partner: PartnerRow;
  open: boolean;
  busy: boolean;
  renaming: boolean;
  onToggle: () => void;
  onVerify: () => void;
  onConfirmStatus: (status: PartnerStatus) => Promise<unknown>;
  onRename: (displayName: string) => void;
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const canChange = useCanChange();

  return (
    <>
      <TableRow>
        <TableCell>{partner.name}</TableCell>
        <TableCell>
          {/*
            Псевдоним заводится вместе с партнёром, но его отсутствие прячут только
            тогда, когда не собираются чинить: без псевдонима клиент партнёра не увидит.
          */}
          {partner.display_name ?? <span className="text-crit">не задан</span>}
        </TableCell>
        <TableCell>
          <span className={`rounded-sm px-1.5 py-0.5 ${partnerStatusTone(partner.status)}`}>
            {PARTNER_STATUS_NAME[partner.status]}
          </span>
        </TableCell>
        <TableCell className="num text-right">
          {/*
            Остаток на счёте партнёра — это долг площадки перед ним: доля за вызовы
            начислена, выплата ещё не сделана. Минус означает обратное, и это разбор,
            а не штатное состояние.
          */}
          <span className={isNegative(partner.balance) ? 'text-crit' : undefined}>
            {money(partner.balance)}
          </span>
        </TableCell>
        <TableCell>
          {partner.listens_to_recordings ? (
            'да'
          ) : (
            <span className="text-muted-foreground">нет</span>
          )}
        </TableCell>
        <TableCell>
          <span className="num text-muted-foreground">{moment(partner.created_at)}</span>
        </TableCell>
        <TableCell>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'Свернуть' : 'Открыть'}
          </Button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <div className="flex flex-col gap-4">
              {canChange && (
                <>
                  <AliasField partner={partner} busy={renaming} onRename={onRename} />
                  <StatusChoice
                    partner={partner}
                    busy={busy}
                    onVerify={onVerify}
                    onConfirmStatus={onConfirmStatus}
                  />
                </>
              )}
              <PartnerEquipment
                partnerId={partner.id}
                onIssued={(secret) => {
                  onIssued({ ...secret, title: `${secret.title} — партнёр «${partner.name}»` });
                }}
              />
              <PartnerRates partnerId={partner.id} />
              <AccountLedger source={`/partners/${partner.id}/entries`} account="partner" />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Смена состояния партнёра.
 *
 * Последствие не косметическое: `verified` — единственное состояние, при котором шлюз
 * регистрируется, а SIM попадают в отбор. Допуск к работе — одним нажатием; всё, что
 * трафик останавливает или необратимо, — через подтверждение с названным последствием
 * ([DESIGN.md](../../../../../docs/DESIGN.md)). Раньше и «Закрыт» срабатывал с первого
 * нажатия (ui-review, 2026-09-14). Из `closed` вариантов нет вовсе: переход необратим,
 * и предлагать его обратно — обещать то, чего API не сделает.
 */
function StatusChoice({
  partner,
  busy,
  onVerify,
  onConfirmStatus,
}: {
  partner: PartnerRow;
  busy: boolean;
  onVerify: () => void;
  onConfirmStatus: (status: PartnerStatus) => Promise<unknown>;
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
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Состояние</h3>
      <p className="text-muted-foreground">
        Сейчас — {PARTNER_STATUS_NAME[partner.status].toLowerCase()}:{' '}
        {PARTNER_STATUS_MEANING[partner.status]} Смена попадает в журнал вместе с тем, что было до.
      </p>
      <div className="flex flex-wrap gap-2">
        {PARTNER_STATUSES.filter((status) => status !== partner.status).map((status) =>
          status === 'verified' ? (
            <Button key={status} variant="outline" size="sm" disabled={busy} onClick={onVerify}>
              {PARTNER_ACTION[status]}
            </Button>
          ) : (
            <ConfirmAction
              key={status}
              label={PARTNER_ACTION[status]}
              title={`${PARTNER_ACTION[status]}: партнёр «${partner.name}»`}
              consequence={<p>{PARTNER_STATUS_MEANING[status]}</p>}
              confirmLabel={PARTNER_ACTION[status]}
              disabled={busy}
              onConfirm={() => onConfirmStatus(status)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Псевдоним, под которым партнёра видит клиент
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 *
 * Единственное, что клиент о партнёре вообще знает, и до появления обработчика
 * задавался только при заведении: опечатка оставалась навсегда и на глазах у всех
 * клиентов. Уникален на всю площадку — занятое имя отвергается с названной причиной.
 */
function AliasField({
  partner,
  busy,
  onRename,
}: {
  partner: PartnerRow;
  busy: boolean;
  onRename: (displayName: string) => void;
}) {
  const [value, setValue] = useState(partner.display_name ?? '');
  const trimmed = value.trim();
  const dirty = trimmed.length >= 2 && trimmed !== (partner.display_name ?? '');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) onRename(trimmed);
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Псевдоним у клиента</span>
        <Input
          className="w-[240px]"
          value={value}
          autoComplete="off"
          placeholder="Партнёр 17"
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={!dirty || busy}>
        {busy ? 'Переименовываем…' : 'Переименовать'}
      </Button>
      <p className="w-full text-muted-foreground">
        Клиенты увидят новое имя сразу. Настоящее имя партнёра им не показывается никогда —
        псевдоним не должен на него намекать. Имя уникально на всю площадку.
      </p>
    </form>
  );
}
