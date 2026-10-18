'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Priorities } from './priorities-view';

/** Приоритеты партнёров для звонков. Для сообщений MAX — страница «Приоритеты MAX». */
export default function MyPrioritiesPage() {
  return (
    <ConsoleShell title="Приоритеты" cabinet="client">
      {() => <Priorities product="calls" />}
    </ConsoleShell>
  );
}
