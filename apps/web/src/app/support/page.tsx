'use client';

import { Suspense } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { SupportView } from '@/components/support-view';

export default function StaffSupportPage() {
  return (
    <ConsoleShell title="Обращения" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <SupportView mode="staff" />
        </Suspense>
      )}
    </ConsoleShell>
  );
}
