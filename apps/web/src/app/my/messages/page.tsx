'use client';

import { ConsoleShell } from '@/components/console-shell';
import { SendMessages } from '@/components/send-messages';

/** Отправка сообщений MAX и журнал отправленного. Остальное — отдельные пункты меню «Сообщения MAX». */
export default function MyMessagesPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="client">
      {() => <SendMessages />}
    </ConsoleShell>
  );
}
