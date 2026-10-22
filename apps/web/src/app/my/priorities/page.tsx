'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Priorities } from './priorities-view';

/** «Маршруты» звонков: требования клиента и очерёдность (ADR-0081, ADR-0095). Для сообщений MAX — «Маршруты» в их группе. */
export default function MyPrioritiesPage() {
  return (
    <ConsoleShell title="Маршруты звонков" cabinet="client">
      {() => <Priorities product="calls" />}
    </ConsoleShell>
  );
}
