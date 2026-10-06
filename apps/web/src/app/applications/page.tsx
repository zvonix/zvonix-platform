'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APPLICATION_STATUSES, type ApplicationStatus, type Cabinet } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { Choice } from '@/components/choice';
import { ConfirmAction } from '@/components/confirm-action';
import { ConfirmEmailButton } from '@/components/confirm-email-button';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { APPLICATION_STATUS_NAME, applicationTone, CABINET_KIND_NAME } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { atMost } from '@/lib/wait';

const PAGE_SIZE = 50;
const COLUMNS = 6;

interface QueuedApplication {
  readonly id: string;
  readonly cabinet: Cabinet;
  readonly status: ApplicationStatus;
  readonly answers: Record<string, unknown>;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly decision_note: string | null;
  readonly applicant: {
    readonly id: string;
    readonly email: string;
    readonly full_name: string;
    readonly status: string;
    readonly email_confirmed: boolean;
  };
}

/**
 * Заявки на кабинет ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Одобрение заводит карточку, открывает вход и пишет письмо — одним действием; отказ
 * отправляет причину письмом. Оба — окно по центру: у одобрения партнёра одно поле
 * (псевдоним), у отказа одно (причина) — правило «окно, страница или панель» из DESIGN.md.
 * По умолчанию открыта очередь ждущих: ради неё сюда и приходят.
 */
export default function ApplicationsPage() {
  return (
    <ConsoleShell title="Заявки" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <ApplicationsTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function ApplicationsTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const columns = useColumnPicker('applications');
  const queryClient = useQueryClient();

  // Пустое значение в адресе — «ждут решения»: сброс отбора возвращает к очереди,
  // а «все» выбираются явно.
  const status = url.get('status') === '' ? 'submitted' : url.get('status');
  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams();
  if (status !== 'all') search.set('status', status);
  search.set('limit', String(PAGE_SIZE));
  if (offset > 0) search.set('offset', String(offset));

  const list = useQuery({
    queryKey: ['applications', search.toString()],
    queryFn: () =>
      request<{ applications: QueuedApplication[]; total: number }>(
        `/applications?${search.toString()}`,
      ),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['applications'] });
  };

  const listError = list.error instanceof ApiError ? list.error : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Choice
          label="Состояние"
          anyLabel="ждут решения"
          value={status === 'submitted' ? '' : status}
          options={[
            ['all', 'все'],
            ...APPLICATION_STATUSES.filter((value) => value !== 'submitted').map(
              (value) => [value, APPLICATION_STATUS_NAME[value]] as const,
            ),
          ]}
          onChange={(value) => {
            url.set({ status: value, offset: '' });
          }}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SavedFilters />
          {columns.picker}
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

      {!canChange && (
        <p className="text-muted-foreground">
          Только чтение: решения по заявкам принимает администратор.
        </p>
      )}
      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Заявитель</TableHead>
              <TableHead className="h-8">Кабинет</TableHead>
              <TableHead className="h-8">Анкета</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Подана</TableHead>
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
            {list.data?.applications.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  {status === 'submitted' ? 'Новых заявок нет.' : 'По этому отбору заявок нет.'}
                </TableCell>
              </TableRow>
            )}
            {list.data?.applications.map((application) => (
              <ApplicationRow
                key={application.id}
                application={application}
                canChange={canChange}
                onDecided={() => atMost(refresh())}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Текстовое поле анкеты. Анкету проверил API, но тип здесь неизвестен — берётся только строка. */
function answerText(application: QueuedApplication, key: string): string {
  const value = application.answers[key];
  return typeof value === 'string' ? value : '';
}

/** Анкета строкой: что человек о себе написал, без заголовков полей. */
function answersLine(application: QueuedApplication): string {
  const a = application.answers;
  const text = (key: string): string | undefined =>
    typeof a[key] === 'string' ? a[key] : typeof a[key] === 'number' ? String(a[key]) : undefined;
  const parts =
    application.cabinet === 'client'
      ? [
          text('companyName'),
          text('city'),
          text('callsPerDay') === undefined
            ? undefined
            : `≈${text('callsPerDay') ?? ''} звонков в день`,
        ]
      : [
          text('region'),
          Array.isArray(a['operators']) ? (a['operators'] as unknown[]).join(', ') : undefined,
          text('simCount') === undefined ? undefined : `${text('simCount') ?? ''} SIM`,
        ];
  return parts.filter((part) => part !== undefined && part !== '').join(' · ');
}

function ApplicationRow({
  application,
  canChange,
  onDecided,
}: {
  application: QueuedApplication;
  canChange: boolean;
  onDecided: () => Promise<unknown>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [note, setNote] = useState('');
  const open = application.status === 'submitted';
  const phone =
    typeof application.answers['phone'] === 'string' ? application.answers['phone'] : '';

  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <div>{application.applicant.full_name}</div>
        <div className="num text-muted-foreground">{application.applicant.email}</div>
        {phone !== '' && <div className="num text-muted-foreground">{phone}</div>}
      </TableCell>
      <TableCell>{CABINET_KIND_NAME[application.cabinet]}</TableCell>
      <TableCell className="max-w-[360px] whitespace-normal">
        {answersLine(application)}
        {application.decision_note !== null && (
          <div className="text-muted-foreground">Причина отказа: {application.decision_note}</div>
        )}
      </TableCell>
      <TableCell>
        <span className={`rounded-sm px-1.5 py-0.5 ${applicationTone(application.status)}`}>
          {APPLICATION_STATUS_NAME[application.status]}
        </span>
        {open && !application.applicant.email_confirmed && (
          <div className="flex flex-col items-start gap-1 pt-1">
            <span className="text-warn">почта не подтверждена — одобрить пока нельзя</span>
            {canChange && (
              <ConfirmEmailButton
                userId={application.applicant.id}
                email={application.applicant.email}
              />
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <span className="num text-muted-foreground">{moment(application.created_at)}</span>
      </TableCell>
      <TableCell className="whitespace-normal">
        {canChange && open && (
          <div className="flex flex-wrap gap-2">
            <ConfirmAction
              label="Одобрить"
              title={`Одобрить заявку: ${application.applicant.full_name}`}
              tone="neutral"
              variant="default"
              disabled={!application.applicant.email_confirmed}
              className={application.applicant.email_confirmed ? '' : 'cursor-not-allowed'}
              confirmLabel="Одобрить и открыть кабинет"
              consequence={
                application.cabinet === 'client' ? (
                  <p>
                    Заведётся карточка клиента «
                    {answerText(application, 'companyName') || application.applicant.full_name}» —
                    сразу рабочая, с нулевым разрешённым минусом. Заявителю откроется вход, и уйдёт
                    письмо.
                  </p>
                ) : (
                  <p>
                    Заведётся карточка партнёра в состоянии «на проверке»: звонки на его SIM пойдут
                    после проверки оборудования. Заявителю откроется вход, и уйдёт письмо.
                  </p>
                )
              }
              onConfirm={async () => {
                await request<unknown>(`/applications/${application.id}/approve`, {
                  method: 'POST',
                  body: application.cabinet === 'partner' ? { displayName } : {},
                });
                await onDecided();
              }}
            >
              {application.cabinet === 'partner' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`alias-${application.id}`}>Псевдоним для клиентов</Label>
                  <Input
                    id={`alias-${application.id}`}
                    value={displayName}
                    placeholder="например, Партнёр 23"
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    Только его видят службы такси. Не должен намекать на личность
                  </span>
                </div>
              )}
            </ConfirmAction>
            <ConfirmAction
              label="Отказать"
              title={`Отказать: ${application.applicant.full_name}`}
              confirmLabel="Отказать и отправить письмо"
              consequence={
                <p>
                  Причина уйдёт заявителю письмом. Первая заявка — вход так и останется закрытым;
                  если кабинет у него уже есть, он продолжит работать.
                </p>
              }
              onConfirm={async () => {
                await request<unknown>(`/applications/${application.id}/reject`, {
                  method: 'POST',
                  body: { note },
                });
                await onDecided();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`note-${application.id}`}>Причина</Label>
                <textarea
                  id={`note-${application.id}`}
                  rows={3}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                  className="rounded-md border border-input bg-transparent px-2.5 py-2"
                />
              </div>
            </ConfirmAction>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
