'use client';

import { ConsoleShell } from '@/components/console-shell';
import { BotConnection } from '../messages/bot-connection';
import { SmppConnection } from '../messages/smpp-connection';

/** Способы подключиться к сообщениям MAX: бот и SMPP. */
export default function MyMessageConnectionsPage() {
  return (
    <ConsoleShell title="Подключения MAX" cabinet="client">
      {() => (
        <div className="flex flex-col gap-4">
          <BotConnection />
          <SmppConnection />
        </div>
      )}
    </ConsoleShell>
  );
}
