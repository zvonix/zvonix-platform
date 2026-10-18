'use client';

import { ConsoleShell } from '@/components/console-shell';
import { MaxLimits } from '../messages/terms';

/** Лимиты сообщений MAX по аккаунтам: только просмотр, меняются в тарифе. Лимиты звонков — на странице «Лимиты». */
export default function PartnerMaxLimitsPage() {
  return (
    <ConsoleShell title="Лимиты MAX" cabinet="partner">
      {() => <MaxLimits />}
    </ConsoleShell>
  );
}
