'use client';

import { ConsoleShell } from '@/components/console-shell';
import { SectionTabs } from '@/components/section-tabs';
import { SendMessages } from '@/components/send-messages';
import { Priorities } from '../priorities/priorities-view';
import { BotConnection } from './bot-connection';
import { SmppConnection } from './smpp-connection';

/**
 * Сообщения MAX клиента: четыре вкладки вместо одной длинной страницы. Цена сообщения — строка над формой отправки,
 * отдельной страницы цен нет.
 */
export default function MyMessagesPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="client">
      {() => (
        <SectionTabs
          tabs={[
            { id: 'send', label: 'Отправка', content: <SendMessages /> },
            { id: 'bot', label: 'Бот', content: <BotConnection /> },
            { id: 'smpp', label: 'Подключение по SMPP', content: <SmppConnection /> },
            {
              id: 'order',
              label: 'Очерёдность партнёров',
              content: <Priorities product="messages" />,
            },
          ]}
        />
      )}
    </ConsoleShell>
  );
}
