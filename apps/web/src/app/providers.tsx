'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Общие настройки запросов.
 *
 * Повтор — только там, где он что-то даёт. Отказ по правам, по отсутствию объекта
 * или по негодной сессии от повтора не изменится: три одинаковых запроса вместо
 * одного лишь задержат страницу, на которую человеку и так пора.
 */
function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (attempt, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return attempt < 2;
        },
        // Панель должна быть живой (DESIGN.md), но не мигать: данные считаются
        // свежими полминуты, а обновление не стирает уже показанное.
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Клиент создаётся в состоянии, а не в модуле: модульная переменная в Next
  // переживает переходы между страницами, но на сервере оказалась бы общей
  // для всех посетителей сразу.
  const [client] = useState(createClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
