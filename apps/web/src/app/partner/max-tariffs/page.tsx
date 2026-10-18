'use client';

import { ConsoleShell } from '@/components/console-shell';
import { MaxTariffs } from '../messages/terms';

/** Тарифы сообщений MAX: цена за сообщение и лимиты. Звонки — на странице «Тарифы», у них свой раздел меню. */
export default function PartnerMaxTariffsPage() {
  return (
    <ConsoleShell title="Тарифы MAX" cabinet="partner">
      {() => <MaxTariffs />}
    </ConsoleShell>
  );
}
