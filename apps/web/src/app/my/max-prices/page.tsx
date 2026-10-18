'use client';

import { useQuery } from '@tanstack/react-query';
import { ConsoleShell } from '@/components/console-shell';
import { request } from '@/lib/api';
import { money } from '@/lib/money';

/** Цена одного сообщения MAX. Цены звонков — на странице «Цены». */
export default function MyMaxPricesPage() {
  return (
    <ConsoleShell title="Цены MAX" cabinet="client">
      {() => <MessagePrice />}
    </ConsoleShell>
  );
}

function MessagePrice() {
  const price = useQuery({
    // Тот же ключ, что у страницы отправки: один запрос на обе.
    queryKey: ['client', 'messages', 'price'],
    queryFn: ({ signal }) =>
      request<{ enabled: boolean; price: string | null }>('/client/messages/price', { signal }),
  });
  if (price.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  if (!price.data.enabled) {
    return <p className="text-muted-foreground">Сообщения MAX на площадке выключены.</p>;
  }
  return (
    <p className="rounded-lg border border-border bg-card p-4">
      {price.data.price === null
        ? 'Цена сообщения пока не задана: отправка недоступна.'
        : `Одно сообщение — ${money(price.data.price)}. Наценка площадки уже внутри. Не доставленное из-за отсутствия MAX у получателя возвращается на счёт.`}
    </p>
  );
}
