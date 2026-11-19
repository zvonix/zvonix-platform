'use client';

import { useQuery } from '@tanstack/react-query';
import { PARTNER_STATUSES } from '@zvonix/shared';
import { ChevronRight, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { Choice } from '@/components/choice';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, RowActions, ROW_ICON, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { ReadOnly } from '@/components/read-only';
import { MoneyOperation } from '@/components/money-operation';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { MoneyTotal } from '@/components/money-total';
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
import { PARTNER_STATUS_NAME, partnerStatusTone } from '@/lib/labels';
import { isNegative } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import { NewPartnerForm } from './new-partner-form';
import type { PartnerRow } from './partner-row';

const PAGE_SIZE = 50;
const COLUMNS = 7;

export default function PartnersPage() {
  return (
    <ConsoleShell title="Партнёры" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <PartnersTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

/**
 * Список партнёров. Подробности — псевдоним, состояние, оборудование, цены, счёт —
 * на карточке `/partners/<id>`, а не раскрытой строкой: карточка с разделами —
 * отдельная страница ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница
 * или панель»), её адрес можно отправить, и она переживает «Назад».
 */
function PartnersTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const columns = useColumnPicker('partners');

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['partners', search.toString()],
    queryFn: () =>
      request<{ partners: PartnerRow[]; total: number }>(`/partners?${search.toString()}`),
  });

  const listError = list.error instanceof ApiError ? list.error : undefined;

  return (
    <div className="flex flex-col gap-3">
      {canChange ? (
        <div>
          <NewPartnerForm />
        </div>
      ) : (
        <ReadOnly what="партнёров, их оборудование и цены" />
      )}

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

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className={TABLE_FRAME}>
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Имя</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Псевдоним у клиента</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} text-right`}>Причитается</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Слушает записи</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Добавлен</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
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
              <PartnerLine key={partner.id} partner={partner} canChange={canChange} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PartnerLine({ partner, canChange }: { partner: PartnerRow; canChange: boolean }) {
  return (
    <TableRow>
      <TableCell>
        {/* Имя — ссылка: на телефоне кнопка «Открыть» уходит за край таблицы. */}
        <Link href={`/partners/${partner.id}`} className="font-medium hover:underline">
          {partner.name}
        </Link>
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        {/*
          Псевдоним заводится вместе с партнёром, но его отсутствие прячут только
          тогда, когда не собираются чинить: без псевдонима клиент партнёра не увидит.
        */}
        {partner.display_name === null ? (
          <StatusDot
            tone="crit"
            label="не задан"
            reason="без псевдонима клиент партнёра не увидит"
          />
        ) : (
          <span
            className="inline-block max-w-48 truncate align-bottom"
            title={partner.display_name}
          >
            {partner.display_name}
          </span>
        )}
      </TableCell>
      <TableCell>
        <StatusDot
          tone={toneOf(partnerStatusTone(partner.status))}
          label={PARTNER_STATUS_NAME[partner.status]}
          phoneDot
        />
      </TableCell>
      <TableCell className={NUM}>
        {/*
          Остаток на счёте партнёра — это долг площадки перед ним: доля за вызовы и сообщения MAX
          начислена, выплата ещё не сделана. Минус означает обратное, и это разбор,
          а не штатное состояние.
        */}
        <span className={isNegative(partner.balance) ? 'text-crit' : undefined}>
          <MoneyTotal value={partner.balance} />
        </span>
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        {partner.listens_to_recordings ? 'да' : <span className="text-muted-foreground">нет</span>}
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        <span className="num text-muted-foreground">{moment(partner.created_at)}</span>
      </TableCell>
      <TableCell>
        <RowActions>
          {canChange && (
            <MoneyOperation
              path={`/partners/${partner.id}/deposit`}
              label="Пополнить"
              icon={<Wallet aria-hidden className="size-4" />}
              title={`Пополнить счёт партнёра «${partner.name}»`}
              description="Сумма добавится к тому, что причитается партнёру."
              reasonPlaceholder="Премия, возмещение, исправление"
              balanceName="Причитается"
              doneText="Проведено"
              invalidate={['partners']}
              reasonOptional
            />
          )}
          <Tooltip label="Открыть">
            <Button asChild {...ROW_ICON}>
              <Link
                href={`/partners/${partner.id}`}
                aria-label={`Открыть партнёра «${partner.name}»`}
              >
                <ChevronRight aria-hidden className="size-4" />
              </Link>
            </Button>
          </Tooltip>
        </RowActions>
      </TableCell>
    </TableRow>
  );
}
