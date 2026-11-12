'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmAction } from '@/components/confirm-action';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { request } from '@/lib/api';
import { LIMITS_KEY, usePartnerLimits } from '@/lib/limits';

/**
 * Как звонят карты партнёра: по рекомендациям площадки или по его лимитам
 * ([ADR-0117](../../../../../../docs/adr/0117-partner-vybiraet-temp-kart.md)).
 *
 * Выключение снимает защиту карт — поэтому с подтверждением и последствием ([DESIGN.md](../../../../../../docs/DESIGN.md),
 * «Опасные действия»); включение обратно — одной кнопкой. Площадка запретила выключать — карточка только сообщает,
 * что карты работают по рекомендациям.
 */
export function CallPace() {
  const limits = usePartnerLimits();
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: (recommended: boolean) =>
      request<unknown>(`/partners/${limits.data?.call_pace.partner_id ?? ''}/call-pace`, {
        method: 'PUT',
        body: { recommended },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIMITS_KEY }),
  });

  if (limits.data === undefined) return null;
  const { recommended, may_disable: mayDisable } = limits.data.call_pace;

  return (
    <section
      aria-label="Как звонят карты"
      className="flex max-w-3xl flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-semibold">Как звонят карты</h3>
        <span className={recommended ? 'text-ok' : 'text-warn'}>
          {recommended ? 'по рекомендациям площадки' : 'по вашим лимитам'}
        </span>
        <Hint label="Что такое рекомендации площадки">
          <p>
            Рекомендации — то, что бережёт карты от блокировки оператором: новая карта звонит
            понемногу (прогрев 14 суток), потом — не больше заданного площадкой в час и в сутки,
            предел каждый день немного разный, разным абонентам — не больше нормы, номер с малым
            числом ответов замедляется.
          </p>
          <p>
            Пауза после звонка и ночной сон номера действуют всегда — без них карту блокируют
            быстрее всего.
          </p>
        </Hint>
        <div className="ml-auto">
          {recommended && mayDisable && (
            <ConfirmAction
              label="Работать по своим лимитам"
              title="Карты будут звонить по вашим лимитам"
              consequence={
                <>
                  <p>
                    Прогрев новых карт, пределы площадки в час и в сутки и остальные рекомендации
                    перестанут действовать на все ваши карты и SIP-провайдеров. Останутся ваши
                    лимиты, пауза после звонка и сон номера.
                  </p>
                  <p>
                    Без своих лимитов карты будут звонить сколько смогут — оператор блокирует такие
                    карты быстрее. Вернуть рекомендации можно в любой момент.
                  </p>
                </>
              }
              confirmLabel="Работать по своим лимитам"
              onConfirm={() => choose.mutateAsync(false)}
            />
          )}
          {!recommended && (
            <Button
              size="sm"
              variant="outline"
              disabled={choose.isPending}
              onClick={() => {
                choose.mutate(true);
              }}
            >
              Вернуть рекомендации площадки
            </Button>
          )}
        </div>
      </div>
      <p className="text-muted-foreground">
        {recommended
          ? mayDisable
            ? 'Ваши лимиты ниже действуют вместе с рекомендациями: побеждает самый строгий.'
            : 'Площадка не разрешает выключать рекомендации. Ваши лимиты ниже действуют вместе с ними.'
          : 'Действуют только ваши лимиты ниже, пауза после звонка и сон номера. Задайте лимиты у тарифов — без них карты звонят без ограничений.'}
      </p>
      {choose.error !== null && !recommended && (
        <p role="alert" className="text-crit">
          {choose.error.message}
        </p>
      )}
    </section>
  );
}
