'use client';

import { useQuery } from '@tanstack/react-query';
import { BotStats } from '@/components/bot-stats';
import { ConsoleShell } from '@/components/console-shell';
import { request } from '@/lib/api';
import { BOT_KEY, BotConnection } from '../messages/bot-connection';

/** Бот MAX клиента своей страницей — отдельно от SMPP (владелец, 2026-10-23); под ним — статистика бота (ADR-0099). */
export default function MyMaxBotPage() {
  return (
    <ConsoleShell title="Бот MAX" cabinet="client">
      {() => <MaxBot />}
    </ConsoleShell>
  );
}

function MaxBot() {
  // Тот же запрос, что у карточки бота: статистика — только когда бот подключён, иначе в ней одни нули.
  const bot = useQuery({
    queryKey: BOT_KEY,
    queryFn: ({ signal }) => request<{ connection: unknown }>('/client/messages/bot', { signal }),
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-4xl">
        <BotConnection />
      </div>
      {bot.data?.connection !== null && bot.data !== undefined && (
        <BotStats base="/client/messages/bot" />
      )}
    </div>
  );
}
