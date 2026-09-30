'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/reports',
  money: [
    { key: 'revenue', label: 'Списано с клиентов' },
    { key: 'partner_cost', label: 'Начислено партнёрам' },
    { key: 'margin', label: 'Остаётся площадке' },
  ],
  dimensions: [
    { by: 'client', label: 'Клиенты' },
    { by: 'partner', label: 'Партнёры' },
    { by: 'operator', label: 'Операторы' },
    { by: 'channel', label: 'Линии' },
    { by: 'sim', label: 'SIM' },
    { by: 'gateway', label: 'Шлюзы' },
  ],
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" requireRole={['admin', 'support']}>
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
