'use client';

import { ConsoleShell } from '@/components/console-shell';
import { SendMessages } from '@/components/send-messages';
import { BotConnection } from './bot-connection';
import { SmppConnection } from './smpp-connection';

export default function MyMessagesPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="client">
      {() => (
        <SendMessages
          between={
            <>
              <BotConnection />
              <SmppConnection />
            </>
          }
        />
      )}
    </ConsoleShell>
  );
}
