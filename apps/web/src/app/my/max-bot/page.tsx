'use client';

import { ConsoleShell } from '@/components/console-shell';
import { BotConnection } from '../messages/bot-connection';

/** Бот MAX клиента своей страницей — отдельно от SMPP (владелец, 2026-10-23); сюда же ляжет статистика бота. */
export default function MyMaxBotPage() {
  return (
    <ConsoleShell title="Бот MAX" cabinet="client">
      {() => (
        <div className="max-w-4xl">
          <BotConnection />
        </div>
      )}
    </ConsoleShell>
  );
}
