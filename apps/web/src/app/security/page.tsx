'use client';

import { AccountView } from '@/components/account-view';
import { ConsoleShell } from '@/components/console-shell';
import { useSession } from '@/lib/session';

export default function SecurityPage() {
  return (
    <ConsoleShell title="Безопасность" requireRole={['admin', 'support']}>
      {() => <Security />}
    </ConsoleShell>
  );
}

/**
 * Безопасность сотрудника: пароль, входы и второй фактор ([ADR-0028](../../../../../docs/adr/0028-vtoroy-faktor.md)).
 * Администратору второй фактор может быть обязателен ([ADR-0067](../../../../../docs/adr/0067-vtoroy-faktor-administratoram.md)) —
 * тогда сюда ведут сразу после входа, остальное закрыто.
 */
function Security() {
  const required = useSession().data?.second_factor_required === true;
  return (
    <AccountView
      staff
      banner={
        required ? (
          <p role="alert" className="rounded-md border border-warn bg-warn-soft p-3 text-warn">
            Администратору нужен второй фактор. Пока он не подключён, остальные разделы закрыты.
          </p>
        ) : undefined
      }
    />
  );
}
