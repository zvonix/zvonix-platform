'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/partner/reports',
  money: [{ key: 'earned', messageKey: 'message_earned', label: 'Заработано' }],
  dimensions: [
    { by: 'sim', label: 'SIM', product: 'calls' },
    { by: 'gateway', label: 'Шлюзы', product: 'calls' },
    { by: 'operator', label: 'Операторы', product: 'calls' },
    { by: 'message_account', label: 'Аккаунты', product: 'messages' },
  ],
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" cabinet="partner">
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
