'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PartnerStatus } from '@zvonix/shared';
import { AccountLedger } from '@/components/account-ledger';
import { ConsoleShell } from '@/components/console-shell';
import { request } from '@/lib/api';
import { PARTNER_STATUS_MEANING, PARTNER_STATUS_NAME } from '@/lib/labels';
import { money } from '@/lib/money';

interface Account {
  readonly partner: {
    readonly id: string;
    readonly name: string;
    readonly display_name: string | null;
    readonly status: PartnerStatus;
    readonly listens_to_recordings: boolean;
    readonly created_at: string;
  };
  readonly funds: { readonly balance: string };
}

export default function PartnerMoneyPage() {
  return (
    <ConsoleShell title="Деньги" requireRole="partner">
      {() => <PartnerMoney />}
    </ConsoleShell>
  );
}

function PartnerMoney() {
  const account = useQuery({
    queryKey: ['partner', 'account'],
    queryFn: () => request<Account>('/partner/account'),
  });

  if (account.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {account.error.message}
      </p>
    );
  }

  if (account.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { partner, funds } = account.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight">{partner.name}</h2>
          <span className="text-muted-foreground">{PARTNER_STATUS_NAME[partner.status]}</span>
        </div>

        {/*
          Состояние показывается всегда, а не только при неисправности: партнёр работает
          только в «подтверждён», и без этой строки человек ищет причину в своём железе.
        */}
        {partner.status !== 'verified' && (
          <p className="text-warn">{PARTNER_STATUS_MEANING[partner.status]}</p>
        )}

        <dl className="grid max-w-[720px] grid-cols-2 gap-x-6 gap-y-1">
          <div>
            <dt className="text-muted-foreground">Заработано, к выплате</dt>
            <dd className="num text-[15px] font-semibold">{money(funds.balance)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Клиент вас видит как</dt>
            <dd>
              {partner.display_name ?? <span className="text-faint">псевдоним не задан</span>}
            </dd>
          </div>
        </dl>

        <p className="max-w-prose text-muted-foreground">
          Начисление приходит за каждый состоявшийся разговор — это ваша доля от того, что заплатил
          клиент. Выплаты пока делает площадка вручную; когда они появятся в кабинете, они будут
          уменьшать эту же сумму проводкой.
        </p>
      </div>

      <RecordingsAccess partnerId={partner.id} listens={partner.listens_to_recordings} />

      <AccountLedger source="/partner/entries" />
    </div>
  );
}

/**
 * Объявление о прослушивании записей ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
 *
 * Единственное действие партнёра над самим собой, и до сих пор оно делалось только
 * через `curl`. Цена решения названа прямо: признак виден клиенту в списке псевдонимов,
 * и клиент, которому это не подходит, поставит такого партнёра ниже.
 */
function RecordingsAccess({ partnerId, listens }: { partnerId: string; listens: boolean }) {
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
