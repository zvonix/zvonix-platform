'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Priorities } from '../priorities/priorities-view';

/** Очерёдность партнёров для сообщений MAX. Для звонков — страница «Приоритеты». */
export default function MyMaxPrioritiesPage() {
  return (
    <ConsoleShell title="Очерёдность партнёров" cabinet="client">
      {() => <Priorities product="messages" />}
    </ConsoleShell>
  );
}
