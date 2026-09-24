'use client';

import { ConsoleShell } from '@/components/console-shell';
import { NumberCheck } from './number-check';
import { OperatorList } from './operator-list';

/**
 * Операторы связи — справочник и проверка номера
 * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md)).
 *
 * На одном экране, потому что вопрос один: почему по номеру не звонят. Либо оператор
 * номера не подтверждён, либо сам оператор — запись импорта, которую человек ещё
 * не смотрел. Раздела не было вовсе: операторы из плана нумерации оставались
 * неподтверждёнными навсегда, а подтвердить оператора номера было нечем.
 */
export default function OperatorsPage() {
  return (
    <ConsoleShell title="Операторы связи" requireRole={['admin', 'support']}>
      {() => (
        <div className="flex flex-col gap-8">
          <NumberCheck />
          <OperatorList />
        </div>
      )}
    </ConsoleShell>
  );
}
