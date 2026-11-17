'use client';

import { useQuery } from '@tanstack/react-query';
import { ConsoleShell } from '@/components/console-shell';
import { Hint } from '@/components/hint';
import { HEAD, NUM, TABLE_FRAME } from '@/components/table-parts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { money } from '@/lib/money';

interface BotPrices {
  readonly available: boolean;
  readonly connection: { readonly enabled: boolean; readonly kind: 'platform' | 'own' } | null;
  readonly terms: { readonly message_price: string; readonly monthly_fee: string };
}

export default function MessagePricesPage() {
  return (
    <ConsoleShell title="Цены сообщений MAX" cabinet="client">
      {() => <MessagePrices />}
    </ConsoleShell>
  );
}

/**
 * Цены сообщений MAX: через аккаунты партнёров (одна цена за сообщение) и через бота (цена и плата за месяц, если бот
 * подключён). Отдельная страница раздела «Сообщения MAX»: в «Цены» звонков они не относятся.
 */
function MessagePrices() {
  const price = useQuery({
    queryKey: ['client', 'messages', 'price'],
    queryFn: ({ signal }) =>
      request<{ enabled: boolean; price: string | null }>('/client/messages/price', { signal }),
  });
  const bot = useQuery({
    queryKey: ['client', 'messages', 'bot'],
    queryFn: ({ signal }) => request<BotPrices>('/client/messages/bot', { signal }),
  });

  if (price.data === undefined || bot.data === undefined) {
    return <p className="text-muted-foreground">Загружаем…</p>;
  }
  const viaAccounts = price.data.enabled ? price.data.price : null;
  const viaBot =
    bot.data.available && bot.data.connection?.enabled === true ? bot.data.terms : null;
  if (viaAccounts === null && viaBot === null) {
    return <p className="text-muted-foreground">Сообщения MAX не подключены.</p>;
  }

  return (
    <section aria-label="Сообщения MAX" className="flex max-w-2xl flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">За сообщение</h2>
        <Hint label="Как считается цена сообщений">
          <p>
            Цена не зависит от длины текста и числа блоков шаблона: одно сообщение — одна цена. Не
            доставленное из-за отсутствия MAX у получателя возвращается на счёт.
          </p>
        </Hint>
      </div>
      {/* «за сообщение» и «в месяц» — заголовками столбцов, а не словами в каждой ячейке (DESIGN.md, «Таблица»). */}
      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Как</TableHead>
              <TableHead className={`${HEAD} text-right`}>За сообщение</TableHead>
              <TableHead className={`${HEAD} text-right`}>В месяц</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {viaAccounts !== null && (
              <TableRow>
                <TableCell className="whitespace-nowrap">Через аккаунты партнёров</TableCell>
                <TableCell className={NUM}>{money(viaAccounts)}</TableCell>
                <TableCell className={NUM}>
                  <span className="text-faint">—</span>
                </TableCell>
              </TableRow>
            )}
            {viaBot !== null && (
              <TableRow>
                <TableCell className="whitespace-nowrap">Через бота</TableCell>
                <TableCell className={NUM}>
                  {Number(viaBot.message_price) === 0 ? 'бесплатно' : money(viaBot.message_price)}
                </TableCell>
                <TableCell className={NUM}>
                  {Number(viaBot.monthly_fee) === 0 ? (
                    <span className="text-faint">—</span>
                  ) : (
                    money(viaBot.monthly_fee)
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
