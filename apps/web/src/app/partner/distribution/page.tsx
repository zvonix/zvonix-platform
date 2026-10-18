'use client';

import { ConsoleShell } from '@/components/console-shell';
import { DistributionView } from './distribution-view';

/** Распределение звонков по картам. Сообщения MAX — на странице «Распределение MAX». */
export default function PartnerDistributionPage() {
  return (
    <ConsoleShell title="Распределение" cabinet="partner">
      {() => <DistributionView product="calls" />}
    </ConsoleShell>
  );
}
