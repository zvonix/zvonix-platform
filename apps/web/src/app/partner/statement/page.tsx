'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Statement, type StatementConfig } from '@/components/statement';

const CONFIG: StatementConfig = {
  path: '/partner/statement',
  party: 'partner',
  moneyKey: 'earned',
  moneyLabel: 'Начислено',
  balanceLabel: 'Причитается',
  chargedLabel: 'Начислено за вызовы',
  dimensions: [
    { by: 'operator', label: 'Операторы' },
    { by: 'gateway', label: 'Шлюзы' },
    { by: 'sim', label: 'SIM' },
  ],
};

export default function StatementPage() {
  return (
    <ConsoleShell title="Выписка за месяц" cabinet="partner">
      {() => <Statement config={CONFIG} />}
    </ConsoleShell>
  );
}
