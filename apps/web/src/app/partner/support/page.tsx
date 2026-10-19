'use client';

import { Suspense } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { SupportView } from '@/components/support-view';

export default function PartnerSupportPage() {
  return (
    <ConsoleShell title="Поддержка" cabinet="partner">
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <SupportView mode="author" cabinet="partner" />
        </Suspense>
      )}
    </ConsoleShell>
  );
}
