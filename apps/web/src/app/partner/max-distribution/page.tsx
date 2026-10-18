'use client';

import { ConsoleShell } from '@/components/console-shell';
import { DistributionView } from '../distribution/distribution-view';

/** Распределение сообщений MAX между аккаунтами. Распределение звонков по картам — на странице «Распределение». */
export default function PartnerMaxDistributionPage() {
  return (
    <ConsoleShell title="Распределение MAX" cabinet="partner">
      {() => <DistributionView product="messages" />}
    </ConsoleShell>
  );
}
