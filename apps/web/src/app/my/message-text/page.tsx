'use client';

import { ConsoleShell } from '@/components/console-shell';
import { TemplateBuilder } from '../messages/template-builder';

/** Конструктор сообщения клиента ([ADR-0087](../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)). */
export default function MyMessageTextPage() {
  return (
    <ConsoleShell title="Текст сообщения" cabinet="client">
      {() => <TemplateBuilder />}
    </ConsoleShell>
  );
}
