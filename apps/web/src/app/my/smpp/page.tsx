'use client';

import { ConsoleShell } from '@/components/console-shell';
import { DeliverySettings } from '../messages/delivery-settings';
import { SmppConnection } from '../messages/smpp-connection';

/**
 * SMPP клиента своей страницей: прежде он делил «Подключения» с ботом, и кнопки входа оказывались под ответами программе
 * (владелец, 2026-10-23). «Если отправить сразу нельзя» — здесь: настройка о приёме сообщений программы, хоть и действует и на API.
 */
export default function MySmppPage() {
  return (
    <ConsoleShell title="SMPP" cabinet="client">
      {() => (
        <SmppConnection>
          <DeliverySettings />
        </SmppConnection>
      )}
    </ConsoleShell>
  );
}
