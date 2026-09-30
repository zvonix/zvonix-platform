'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/partner/reports',
  money: [{ key: 'earned', label: 'Заработано' }],
  dimensions: [
    { by: 'sim', label: 'SIM' },
    { by: 'gateway', label: 'Шлюзы' },
    { by: 'operator', label: 'Операторы' },
  ],
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" cabinet="partner">
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
