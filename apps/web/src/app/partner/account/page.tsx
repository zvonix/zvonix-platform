'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';

/** Аккаунт партнёра: пароль, входы, второй фактор. */
export default function PartnerAccountPage() {
  return (
    <ConsoleShell title="Аккаунт" cabinet="partner">
      {() => <AccountView />}
    </ConsoleShell>
  );
}
