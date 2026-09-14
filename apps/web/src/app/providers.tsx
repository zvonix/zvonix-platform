'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { shouldRetryQuery } from '@/lib/query-retry';

/**
 * Общие настройки запросов.
 *
 * Чтение повторяется только там, где повтор что-то даёт (`shouldRetryQuery`).
 *
 * Изменение, не дождавшееся ответа, могло выполниться. Такой отказ перечитывает все
 * экраны: человек видит исход своими глазами, а не гадает о нём и не повторяет
 * вслепую (DESIGN.md, «Неизвестный исход»).
 */
function createClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof ApiError && error.timedOut) void client.invalidateQueries();
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        // Панель должна быть живой (DESIGN.md), но не мигать: данные считаются
        // свежими полминуты, а обновление не стирает уже показанное.
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
  return client;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Клиент создаётся в состоянии, а не в модуле: модульная переменная в Next
  // переживает переходы между страницами, но на сервере оказалась бы общей
  // для всех посетителей сразу.
  const [client] = useState(createClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
