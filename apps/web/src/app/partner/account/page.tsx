'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';
import { TimezoneSetting } from '@/components/timezone-setting';
import { usePartnerAccount } from '@/lib/account';
import { RecordingsAccess } from './recordings-access';

/** Аккаунт партнёра: пароль, входы, второй фактор, объявление о прослушивании записей и часовой пояс лимитов. */
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
          alias={account.data.partner.display_name}
        />
      )}
      {account.data !== undefined && (
        <TimezoneSetting
          current={account.data.partner.timezone}
          endpoint="/partner/account/timezone"
          invalidate={[
            ['partner', 'account'],
            ['partner', 'limits'],
          ]}
        />
      )}
    </div>
  );
}
