'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';
import { TimezoneSetting } from '@/components/timezone-setting';
import { useClientAccount } from '@/lib/account';

/** Аккаунт клиента: пароль, входы, второй фактор и часовой пояс лимитов. */
export default function MyAccountPage() {
  return (
    <ConsoleShell title="Аккаунт" cabinet="client">
      {() => <MyAccount />}
    </ConsoleShell>
  );
}

function MyAccount() {
  const account = useClientAccount();
  return (
    <div className="flex flex-col gap-4">
      <AccountView />
      {account.data !== undefined && (
        <TimezoneSetting
          current={account.data.client.timezone}
          endpoint="/client/account/timezone"
          invalidate={[
            ['my', 'account'],
            ['my', 'limits'],
          ]}
        />
      )}
    </div>
  );
}
