'use client';

import { AccountLedger } from '@/components/account-ledger';
import { ConsoleShell } from '@/components/console-shell';
import { useClientAccount } from '@/lib/account';
import { CLIENT_STATUS_MEANING, CLIENT_STATUS_NAME } from '@/lib/labels';
import { isNegative, money } from '@/lib/money';

export default function MyMoneyPage() {
  return (
    <ConsoleShell title="Деньги" cabinet="client">
      {() => <MyMoney />}
    </ConsoleShell>
  );
}

function MyMoney() {
  const account = useClientAccount();

  if (account.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {account.error.message}
      </p>
    );
  }

  if (account.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { client, funds } = account.data;
  const blocked = client.status !== 'active';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight">{client.name}</h2>
          <span className="text-muted-foreground">{CLIENT_STATUS_NAME[client.status]}</span>
        </div>

        {/*
          Состояние клиента показывается всегда, а не только при неисправности:
          «приостановлен» объясняет, почему не идут вызовы, и без этой строки человек
          ищет причину в своей АТС.
        */}
        {blocked && <p className="text-warn">{CLIENT_STATUS_MEANING[client.status]}</p>}

        <dl className="grid max-w-[720px] grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
          <Figure title="Можно потратить" value={funds.available} strong />
          <Figure title="Остаток" value={funds.balance} />
          <Figure title="Придержано под вызовы" value={funds.held} />
          <Figure title="Разрешённый минус" value={funds.overdraft_limit} />
        </dl>
      </div>

      <AccountLedger source="/client/entries" account="client" />
    </div>
  );
}

/** Сумма с подписью. Отрицательный остаток выделяется, но без паники — это штатно. */
function Figure({ title, value, strong }: { title: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{title}</dt>
      <dd
        className={[
          'num',
          strong === true ? 'text-[15px] font-semibold' : '',
          isNegative(value) ? 'text-crit' : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
      >
        {money(value)}
      </dd>
    </div>
  );
}
