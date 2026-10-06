'use client';

import { ConsoleShell } from '@/components/console-shell';
import { SendMessages } from '@/components/send-messages';
import { SmppConnection } from './smpp-connection';

export default function MyMessagesPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="client">
      {() => <SendMessages between={<SmppConnection />} />}
    </ConsoleShell>
  );
}
