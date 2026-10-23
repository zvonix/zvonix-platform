'use client';

import { useQuery } from '@tanstack/react-query';
import { FormDialog } from '@/components/form-dialog';
import { MessengerAccountStatus } from '@/components/messenger-status';
import { SmppEvents } from '@/components/smpp-events';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { money } from '@/lib/money';
import { useBreakdown } from '@/lib/reports';

/** За сколько суток показывать сообщения в карточке: как в сводке, «30 дней». */
const DAYS = 30;

interface SmppConnection {
  readonly client_id: string;
  readonly system_id: string;
  readonly enabled: boolean;
  readonly last_bind_at: string | null;
  readonly online: readonly { ip: string }[];
}

interface BotClient {
  readonly client_id: string;
  readonly bot: { readonly kind: 'platform' | 'own'; readonly username: string };
  readonly enabled: boolean;
  readonly subscribers: number;
}

interface MessengerAccount {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly state_reason: string | null;
  readonly partner_id: string;
  readonly price: string | null;
}

/**
 * Сообщения MAX в карточке клиента: подключения (SMPP, бот) и сколько отправил и потратил за 30 суток. Карточка была только
 * о звонках — линии и деньги, — и чтобы понять, работает ли клиент с MAX, приходилось обходить три раздела (владелец,
 * 2026-10-23). Данные — те же, что в «Аккаунтах и боте» и «Сводке»: отдельного запроса на карточку нет.
 */
export function ClientMaxCard({ clientId }: { clientId: string }) {
  const smpp = useQuery({
    queryKey: ['smpp', 'accounts'],
    queryFn: ({ signal }) => request<{ accounts: SmppConnection[] }>('/smpp/accounts', { signal }),
  });
  const bots = useQuery({
    queryKey: ['bots', 'platform', 'clients'],
    queryFn: ({ signal }) =>
      request<{ clients: BotClient[] }>('/bots/platform/clients', { signal }),
  });
  const sent = useBreakdown('/reports', DAYS, 'message_client');

  const connection = smpp.data?.accounts.find((row) => row.client_id === clientId);
  const bot = bots.data?.clients.find((row) => row.client_id === clientId);
  const totals = sent.data?.rows.find((row) => row.key === clientId);

  return (
    <section aria-label="Сообщения MAX" className="flex flex-col gap-2">
      <h2 className="font-semibold">Сообщения MAX</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">За {String(DAYS)} суток</dt>
        <dd className="num">
          {totals === undefined
            ? 'сообщений не было'
            : `${String(totals.messages)} отправлено, ${String(totals.messages_delivered)} доставлено · ${money(totals.message_revenue ?? '0')}`}
        </dd>

        <dt className="text-muted-foreground">SMPP</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {connection === undefined ? (
            <span className="text-muted-foreground">не подключён</span>
          ) : (
            <>
              <span className="num">{connection.system_id}</span>
              <span className={connection.enabled ? 'text-ok' : 'text-warn'}>
                {connection.enabled ? 'включён' : 'отключён'}
              </span>
              <span className="text-muted-foreground">
                {connection.online.length > 0
                  ? 'сейчас на связи'
                  : `был ${moment(connection.last_bind_at)}`}
              </span>
              <FormDialog label="Журнал" title="Журнал SMPP" variant="outline" size="xs">
                <SmppEvents url={`/smpp/accounts/${clientId}/events`} />
              </FormDialog>
            </>
          )}
        </dd>

        <dt className="text-muted-foreground">Бот</dt>
        <dd>
          {bot === undefined ? (
            <span className="text-muted-foreground">не подключён</span>
          ) : (
            <>
              {bot.bot.kind === 'own' ? `свой @${bot.bot.username}` : 'бот площадки'} ·{' '}
              <span className={bot.enabled ? 'text-ok' : 'text-warn'}>
                {bot.enabled ? 'включён' : 'выключен'}
              </span>{' '}
              · подписчиков <span className="num">{String(bot.subscribers)}</span>
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}

/**
 * Сообщения MAX в карточке партнёра: его аккаунты и сколько через них ушло и начислено за 30 суток. Карточка была только
 * об оборудовании и ценах звонков (владелец, 2026-10-23).
 */
export function PartnerMaxCard({ partnerId }: { partnerId: string }) {
  const accounts = useQuery({
    queryKey: ['messenger', 'accounts', 'all'],
    queryFn: ({ signal }) =>
      request<{ accounts: MessengerAccount[] }>('/messenger/accounts', { signal }),
  });
  const sent = useBreakdown('/reports', DAYS, 'message_partner');

  const own = accounts.data?.accounts.filter((row) => row.partner_id === partnerId) ?? [];
  const totals = sent.data?.rows.find((row) => row.key === partnerId);

  return (
    <section aria-label="Сообщения MAX" className="flex flex-col gap-2">
      <h2 className="font-semibold">Сообщения MAX</h2>
      <p className="num">
        За {String(DAYS)} суток:{' '}
        {totals === undefined
          ? 'сообщений не было'
          : `${String(totals.messages)} отправлено, ${String(totals.messages_delivered)} доставлено · начислено ${money(totals.message_partner_cost ?? '0')}`}
      </p>
      {own.length === 0 ? (
        <p className="text-muted-foreground">Аккаунтов MAX нет.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {own.map((account) => (
            <li key={account.id} className="flex flex-wrap items-center gap-2">
              <span>{account.label}</span>
              <MessengerAccountStatus status={account.status} reason={account.state_reason} staff />
              <span className="num text-muted-foreground">
                {account.price === null ? 'цена по тарифу' : `${money(account.price)} за сообщение`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
