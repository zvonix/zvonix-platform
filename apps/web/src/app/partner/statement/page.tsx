'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Statement, type StatementConfig } from '@/components/statement';

const CONFIG: StatementConfig = {
  path: '/partner/statement',
  party: 'partner',
  moneyKey: 'earned',
  messageMoneyKey: 'message_earned',
  moneyLabel: 'Начислено',
  balanceLabel: 'Причитается',
  chargedLabel: 'Начислено за вызовы',
  messageLabel: 'Начислено за сообщения MAX',
  dimensions: [
    { by: 'operator', label: 'Операторы', product: 'calls' },
    { by: 'gateway', label: 'Шлюзы', product: 'calls' },
    { by: 'sim', label: 'SIM', product: 'calls' },
    { by: 'message_account', label: 'Аккаунты', product: 'messages' },
  ],
};

export default function StatementPage() {
  return (
    <ConsoleShell title="Выписка" cabinet="partner">
      {() => <Statement config={CONFIG} />}
    </ConsoleShell>
  );
}
