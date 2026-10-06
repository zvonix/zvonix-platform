'use client';

import Link from 'next/link';
import { ConsoleShell } from '@/components/console-shell';
import { SendMessages } from '@/components/send-messages';
import { useCabinets } from '@/lib/cabinets';

/**
 * Отправка сообщений MAX из кабинета партнёра (владелец 2026-10-06: «по цене, как всем»).
 *
 * Партнёр отправляет **как клиент**: цена та же, что у остальных, деньги списываются со счёта его клиентского
 * кабинета, журнал общий. Отдельного пути без денег нет намеренно. Нет клиентского кабинета — страница ведёт
 * к заявке на него, а не показывает форму, которая отказала бы.
 */
export default function PartnerSendPage() {
  return (
    <ConsoleShell title="Отправить сообщение" cabinet="partner">
      {() => <Send />}
    </ConsoleShell>
  );
}

function Send() {
  const cabinets = useCabinets();
  if (cabinets.data === undefined) return null;
  const client = cabinets.data.client;

  if (client === null) {
    return (
      <div className="flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <p>
          Сообщения отправляются со счёта клиентского кабинета, по той же цене, что и остальным.
          Клиентского кабинета у вас пока нет.
        </p>
        {cabinets.data.second_cabinet_open ? (
          <div>
            <Link
              href="/apply?cabinet=client"
              className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 font-semibold text-primary-foreground"
            >
              Стать клиентом
            </Link>
          </div>
        ) : (
          <p className="text-muted-foreground">Площадка пока не подключает второй кабинет.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        Деньги списываются со счёта вашего клиентского кабинета «{client.name}».
      </p>
      <SendMessages />
    </div>
  );
}
