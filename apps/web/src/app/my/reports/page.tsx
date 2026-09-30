'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Report, type ReportConfig } from '@/components/report';

const CONFIG: ReportConfig = {
  base: '/client/reports',
  money: [{ key: 'spent', label: 'Потрачено' }],
  dimensions: [
    { by: 'operator', label: 'Операторы' },
    { by: 'channel', label: 'Линии' },
  ],
};

export default function ReportPage() {
  return (
    <ConsoleShell title="Сводка" cabinet="client">
      {() => <Report config={CONFIG} />}
    </ConsoleShell>
  );
}
