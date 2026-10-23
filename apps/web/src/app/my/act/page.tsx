'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Statement, type StatementConfig } from '@/components/statement';

const CONFIG: StatementConfig = {
  path: '/client/statement',
  party: 'client',
  moneyKey: 'spent',
  messageMoneyKey: 'message_spent',
  moneyLabel: 'Потрачено',
  balanceLabel: 'Остаток',
  chargedLabel: 'Списано за вызовы',
  messageLabel: 'Списано за сообщения MAX',
  dimensions: [
    { by: 'operator', label: 'Операторы', product: 'calls' },
    { by: 'channel', label: 'Линии', product: 'calls' },
    { by: 'message_route', label: 'Через что', product: 'messages' },
    { by: 'message_channel', label: 'Откуда', product: 'messages' },
  ],
};

export default function ActPage() {
  return (
    <ConsoleShell title="Акт" cabinet="client">
      {() => <Statement config={CONFIG} />}
    </ConsoleShell>
  );
}
