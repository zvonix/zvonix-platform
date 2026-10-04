'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Statement, type StatementConfig } from '@/components/statement';

const CONFIG: StatementConfig = {
  path: '/client/statement',
  party: 'client',
  moneyKey: 'spent',
  moneyLabel: 'Потрачено',
  balanceLabel: 'Остаток',
  chargedLabel: 'Списано за вызовы',
  dimensions: [
    { by: 'operator', label: 'Операторы' },
    { by: 'channel', label: 'Линии' },
  ],
};

export default function ActPage() {
  return (
    <ConsoleShell title="Акт за месяц" cabinet="client">
      {() => <Statement config={CONFIG} />}
    </ConsoleShell>
  );
}
