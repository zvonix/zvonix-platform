'use client';

import { ConsoleShell } from '@/components/console-shell';
import { BotConnection } from '../messages/bot-connection';
import { DeliverySettings } from '../messages/delivery-settings';
import { SmppConnection } from '../messages/smpp-connection';

/** Способы подключиться к сообщениям MAX: бот и SMPP — на широком экране рядом (владелец: «места много, а всё в узкой полосе»). */
export default function MyMessageConnectionsPage() {
  return (
    <ConsoleShell title="Подключения MAX" cabinet="client">
      {() => (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <BotConnection />
          <div className="flex flex-col gap-4">
            <SmppConnection />
            <DeliverySettings />
          </div>
        </div>
      )}
    </ConsoleShell>
  );
}
