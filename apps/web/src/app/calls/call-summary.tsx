'use client';

import { useQuery } from '@tanstack/react-query';
import type { CallFailureReason, CallStatus } from '@zvonix/shared';
import { request } from '@/lib/api';
import { CALL_STATUS_NAME, callTone, FAILURE_REASON_FIX, FAILURE_REASON_NAME } from '@/lib/labels';

interface Summary {
  readonly total: number;
  readonly by_status: readonly { status: CallStatus; count: number }[];
  readonly by_reason: readonly { reason: CallFailureReason; count: number }[];
}

/**
 * Ответ на вопрос, с которого начинается обращение: «почему не звонит».
 *
 * Считается по всему периоду, а не по выданной странице: страница показывает полсотни
 * строк, а спрашивают про сутки. Причины идут по убыванию частоты — разбор начинают
 * с самой частой, и порядок «как в перечислении» заставлял бы её искать глазами.
 *
 * У каждой причины назван виновник и раздел, где это чинится: причина без указания
 * на действие оставляет разбор на полпути.
 */
export function CallSummary({ query }: { query: string }) {
  const summary = useQuery({
    queryKey: ['calls', 'summary', query],
    queryFn: () => request<Summary>(`/calls/summary?${query}`),
  });

  if (summary.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {summary.error.message}
      </p>
    );
  }

  if (summary.isPending) {
    return <p className="text-muted-foreground">Считаем…</p>;
  }

  const data = summary.data;
  if (data.total === 0) {
    return (
      <p className="text-muted-foreground">
        За выбранный период вызовов не было. Если клиент говорит, что звонил, — значит его вызовы не
        дошли до платформы: смотреть надо на узел и настройку АТС, а не здесь.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Всего вызовов</span>
        <span className="num text-[15px] font-semibold">{data.total}</span>
        {data.by_status.map((row) => (
          <span key={row.status} className={`rounded-md px-2 py-0.5 ${callTone(row.status)}`}>
            {CALL_STATUS_NAME[row.status]} · <span className="num">{row.count}</span>
          </span>
        ))}
      </div>

      {data.by_reason.length === 0 ? (
        <p className="text-ok">Отказов за период не было.</p>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-3 py-2 text-muted-foreground">
            Почему не состоялись
          </div>
          <ul className="divide-y divide-border">
            {data.by_reason.map((row) => (
              <li key={row.reason} className="flex gap-3 px-3 py-2">
                <span className="num w-12 shrink-0 text-right font-semibold">{row.count}</span>
                <span className="num w-12 shrink-0 text-right text-muted-foreground">
                  {share(row.count, data.total)}
                </span>
                <span className="min-w-0">
                  <span className="block">{FAILURE_REASON_NAME[row.reason]}</span>
                  <span className="block text-muted-foreground">
                    {FAILURE_REASON_FIX[row.reason]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Доля в процентах без дробной части: разбор ведут по порядку величины, а не по десятым. */
function share(count: number, total: number): string {
  return `${String(Math.round((count / total) * 100))}%`;
}
