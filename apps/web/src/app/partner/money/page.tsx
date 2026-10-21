'use client';

import { AccountLedger } from '@/components/account-ledger';
import { ConsoleShell } from '@/components/console-shell';
import { usePartnerAccount } from '@/lib/account';
import { PARTNER_STATUS_MEANING, PARTNER_STATUS_NAME } from '@/lib/labels';
import { money } from '@/lib/money';

export default function PartnerMoneyPage() {
  return (
    <ConsoleShell title="Деньги" cabinet="partner">
      {() => <PartnerMoney />}
    </ConsoleShell>
  );
}

function PartnerMoney() {
  const account = usePartnerAccount();

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
      </div>

      <AccountLedger source="/partner/entries" account="partner" />
    </div>
  );
}
