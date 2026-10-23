'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/client/reports',
  money: [{ key: 'spent', messageKey: 'message_spent', label: 'Потрачено' }],
  dimensions: [
    { by: 'operator', label: 'Операторы', product: 'calls' },
    { by: 'channel', label: 'Линии', product: 'calls' },
    { by: 'message_route', label: 'Через что', product: 'messages' },
    { by: 'message_channel', label: 'Откуда', product: 'messages' },
  ],
  botFeeLabel: 'бот',
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" cabinet="client">
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
