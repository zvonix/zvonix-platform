'use client';

import { MoneyOperation } from '@/components/money-operation';

/**
 * Ручные денежные операции над счётом партнёра. «Причитается» — долг площадки перед ним:
 * пополнение его увеличивает (премия, возмещение, исправление), выплата и списание
 * уменьшают. Выплата — когда деньги партнёру реально переведены; списание — исправление
 * ошибочного начисления. Больше причитающегося убрать нельзя: сервер ответит отказом.
 */
export function PartnerMoney({ partnerId, name }: { partnerId: string; name: string }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <MoneyOperation
        path={`/partners/${partnerId}/payout`}
        label="Выплатить"
        title={`Выплата партнёру «${name}»`}
        description="Запишите перевод, который вы уже сделали: причитающееся уменьшится на эту сумму. Больше, чем причитается, выплатить нельзя."
        reasonPlaceholder="Перевод на карту 02.10.2026"
        balanceName="Причитается"
        doneText="Выплата записана"
        invalidate={['partners']}
      />
      <MoneyOperation
        path={`/partners/${partnerId}/deposit`}
        label="Пополнить"
        title={`Пополнить счёт партнёра «${name}»`}
        description="Сумма добавится к тому, что причитается партнёру."
        reasonPlaceholder="Премия, возмещение, исправление"
        balanceName="Причитается"
        doneText="Проведено"
        variant="outline"
        invalidate={['partners']}
      />
      <MoneyOperation
        path={`/partners/${partnerId}/debit`}
        label="Списать"
        title={`Списать со счёта партнёра «${name}»`}
        description="Исправление ошибочного начисления: причитающееся уменьшится, но это не выплата."
        reasonPlaceholder="Начислено по ошибке"
        balanceName="Причитается"
        doneText="Списано"
        variant="outline"
        invalidate={['partners']}
      />
    </div>
  );
}
