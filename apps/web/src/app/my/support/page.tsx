'use client';

import { Suspense } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { SupportView } from '@/components/support-view';

export default function MySupportPage() {
  return (
    <ConsoleShell title="Поддержка" cabinet="client">
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <SupportView mode="author" cabinet="client" />
        </Suspense>
      )}
    </ConsoleShell>
  );
}
