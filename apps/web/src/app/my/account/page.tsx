'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';

/** Аккаунт клиента: пароль, входы, второй фактор. */
export default function MyAccountPage() {
  return (
    <ConsoleShell title="Аккаунт" cabinet="client">
      {() => <AccountView />}
    </ConsoleShell>
  );
}
