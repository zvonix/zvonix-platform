'use client';

import { ConsoleShell } from '@/components/console-shell';
import { BlockedNumbers } from './blocked-numbers';
import { LimitRules } from './limit-rules';

/**
 * Запреты и лимиты — два способа сказать «этого делать нельзя».
 *
 * На одном экране, потому что разбор приходит сюда с одним вопросом: почему вызов
 * отклонён платформой, а не сетью. Причины `destination_blocked` и `limit_exceeded`
 * объясняются здесь, и искать их в разных разделах было бы лишним шагом.
 */
export default function LimitsPage() {
  return (
    <ConsoleShell title="Запреты и лимиты" requireRole={['admin', 'support']}>
      {() => (
        <div className="flex flex-col gap-6">
          <BlockedNumbers />
          <LimitRules />
        </div>
      )}
    </ConsoleShell>
  );
}
