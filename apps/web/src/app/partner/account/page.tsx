'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';
import { usePartnerAccount } from '@/lib/account';
import { RecordingsAccess } from './recordings-access';

/** Аккаунт партнёра: пароль, входы, второй фактор и объявление о прослушивании записей. */
export default function PartnerAccountPage() {
  return (
    <ConsoleShell title="Аккаунт" cabinet="partner">
      {() => <PartnerAccount />}
    </ConsoleShell>
  );
}

function PartnerAccount() {
  const account = usePartnerAccount();
  return (
    <div className="flex flex-col gap-4">
      <AccountView />
      {account.data !== undefined && (
        <RecordingsAccess
          partnerId={account.data.partner.id}
          listens={account.data.partner.listens_to_recordings}
        />
      )}
    </div>
  );
}
