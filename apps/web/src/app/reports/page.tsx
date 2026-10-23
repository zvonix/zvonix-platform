'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/reports',
  money: [
    { key: 'revenue', messageKey: 'message_revenue', label: 'Списано с клиентов' },
    { key: 'partner_cost', messageKey: 'message_partner_cost', label: 'Начислено партнёрам' },
    { key: 'margin', messageKey: 'message_margin', label: 'Остаётся площадке' },
  ],
  dimensions: [
    { by: 'client', label: 'Клиенты', product: 'calls' },
    { by: 'partner', label: 'Партнёры', product: 'calls' },
    { by: 'operator', label: 'Операторы', product: 'calls' },
    { by: 'channel', label: 'Линии', product: 'calls' },
    { by: 'sim', label: 'SIM', product: 'calls' },
    { by: 'gateway', label: 'Шлюзы', product: 'calls' },
    { by: 'message_client', label: 'Клиенты', product: 'messages' },
    { by: 'message_partner', label: 'Партнёры', product: 'messages' },
    { by: 'message_account', label: 'Аккаунты', product: 'messages' },
    { by: 'message_route', label: 'Через что', product: 'messages' },
    { by: 'message_channel', label: 'Откуда', product: 'messages' },
  ],
  botFeeLabel: 'плата за бота',
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" requireRole={['admin', 'support']}>
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
