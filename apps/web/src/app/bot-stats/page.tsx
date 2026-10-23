'use client';

import { useQuery } from '@tanstack/react-query';
import { BotStats } from '@/components/bot-stats';
import { ConsoleShell } from '@/components/console-shell';
import { request } from '@/lib/api';
import { useUrlState } from '@/lib/url-state';

/** Статистика бота любого клиента — та же, что у клиента (ADR-0099); клиент выбирается сверху и хранится в адресе. */
export default function BotStatsPage() {
  return (
    <ConsoleShell title="Статистика бота" requireRole={['admin', 'support']}>
      {() => <Staff />}
    </ConsoleShell>
  );
}

function Staff() {
  const url = useUrlState();
  const clientId = url.get('client');
  const clients = useQuery({
    queryKey: ['bots', 'platform', 'clients'],
    queryFn: ({ signal }) =>
      request<{ clients: { client_id: string; client_name: string }[] }>('/bots/platform/clients', {
        signal,
      }),
  });
  const list = clients.data?.clients ?? [];
  const chosen = clientId === '' ? list[0]?.client_id : clientId;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Клиент</span>
        <select
          value={chosen ?? ''}
          onChange={(event) => {
            url.set({ client: event.target.value });
          }}
          className="h-9 w-[260px] rounded-md border border-input bg-transparent px-2"
        >
          {list.map((client) => (
            <option key={client.client_id} value={client.client_id}>
              {client.client_name}
            </option>
          ))}
        </select>
      </label>
      {clients.data !== undefined && list.length === 0 && (
        <p className="text-muted-foreground">К боту площадки пока никто не подключён.</p>
      )}
      {chosen !== undefined && <BotStats key={chosen} base={`/bots/clients/${chosen}`} />}
    </div>
  );
}
