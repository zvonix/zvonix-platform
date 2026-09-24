'use client';

import { useQuery } from '@tanstack/react-query';
import { PARTNER_STATUSES } from '@zvonix/shared';
import Link from 'next/link';
import { Suspense } from 'react';
import { Choice } from '@/components/choice';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { ReadOnly } from '@/components/read-only';
import { Button } from '@/components/ui/button';
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
import { isNegative, money } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import { NewPartnerForm } from './new-partner-form';
import type { PartnerRow } from './partner-row';

const PAGE_SIZE = 50;
const COLUMNS = 7;

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

/**
 * Список партнёров. Подробности — псевдоним, состояние, оборудование, цены, счёт —
 * на карточке `/partners/<id>`, а не раскрытой строкой: карточка с разделами —
 * отдельная страница ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница
 * или панель»), её адрес можно отправить, и она переживает «Назад».
 */
function PartnersTable() {
  const canChange = useCanChange();
  const url = useUrlState();

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

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Имя</TableHead>
              <TableHead className="h-8">Псевдоним у клиента</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Причитается</TableHead>
              <TableHead className="h-8">Слушает записи</TableHead>
              <TableHead className="h-8">Добавлен</TableHead>
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
              <PartnerLine key={partner.id} partner={partner} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PartnerLine({ partner }: { partner: PartnerRow }) {
  return (
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
        {partner.listens_to_recordings ? 'да' : <span className="text-muted-foreground">нет</span>}
      </TableCell>
      <TableCell>
        <span className="num text-muted-foreground">{moment(partner.created_at)}</span>
      </TableCell>
      <TableCell>
        <Button asChild variant="outline" size="sm">
          <Link href={`/partners/${partner.id}`} aria-label={`Открыть партнёра «${partner.name}»`}>
            Открыть
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}
