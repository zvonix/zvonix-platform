'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Priorities } from '../priorities/priorities-view';

/** Приоритеты партнёров для сообщений MAX. Для звонков — страница «Приоритеты». */
export default function MyMaxPrioritiesPage() {
  return (
    <ConsoleShell title="Приоритеты MAX" cabinet="client">
      {() => <Priorities product="messages" />}
    </ConsoleShell>
  );
}
