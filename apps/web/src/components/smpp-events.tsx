'use client';

import { useQuery } from '@tanstack/react-query';
import type { SmppBindMode, SmppEventKind } from '@zvonix/shared';
import { ErrorNote } from '@/components/error-note';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

interface SmppEvent {
  readonly kind: SmppEventKind;
  readonly result: string;
  readonly ip: string;
  readonly mode: SmppBindMode | null;
  readonly count: number;
  readonly first_at: string;
  readonly last_at: string;
}

/** Итог события словами — что произошло и что с этим делать. */
const RESULT_NAME: Record<string, string> = {
  ok: 'Вход выполнен',
  wrong_password: 'Неверный пароль',
  ip_not_allowed: 'Адрес не в списке разрешённых',
  disabled: 'Подключение выключено',
  product_off: 'Сообщения MAX выключены на площадке',
  client_inactive: 'Кабинет клиента не работает',
  too_many_sessions: 'Слишком много одновременных подключений',
  ip_blocked: 'Адрес на минуту заблокирован: 5 неверных паролей подряд',
  invalid_destination: 'Сообщение: номер не разобран',
  invalid_length: 'Сообщение: пустой или слишком длинный текст',
  wrong_mode: 'Сообщение: вход только для отчётов',
  rejected: 'Сообщение отклонено (деньги, требования, «не писать»)',
  throttled: 'Сообщение: занято, программе — «повторите»',
  system_error: 'Сообщение: сбой площадки',
};

export const MODE_NAME: Record<SmppBindMode, string> = {
  transmitter: 'отправка',
  receiver: 'отчёты',
  transceiver: 'отправка и отчёты',
};

/**
 * Журнал подключения SMPP ([ADR-0096](../../../../docs/adr/0096-zhurnal-podklyucheniy-smpp.md)): входы и отказы в приёме, новые
 * сверху. Отвечает на «доходит ли вообще»: пусто — программа к площадке не подключалась.
 */
export function SmppEvents({ url }: { url: string }) {
  const events = useQuery({
    queryKey: ['smpp-events', url],
    queryFn: ({ signal }) => request<{ events: SmppEvent[] }>(url, { signal }),
    refetchInterval: 15_000,
  });

  if (events.error instanceof ApiError) return <ErrorNote error={events.error} />;
  if (events.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  if (events.data.events.length === 0) {
    return (
      <p className="text-muted-foreground">
        Подключений не было: программа к площадке не обращалась.
      </p>
    );
  }
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableHead className="h-8">Когда</TableHead>
            <TableHead className="h-8">Что</TableHead>
            <TableHead className="h-8">Адрес</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.data.events.map((event) => (
            <TableRow key={`${event.first_at}-${event.kind}-${event.result}-${event.ip}`}>
              <TableCell className="num text-muted-foreground">{moment(event.last_at)}</TableCell>
              <TableCell className="whitespace-normal">
                <span className={event.result === 'ok' ? 'text-ok' : 'text-warn'}>
                  {RESULT_NAME[event.result] ?? event.result}
                </span>
                {event.kind === 'bind' && event.mode !== null && (
                  <span className="text-muted-foreground"> · {MODE_NAME[event.mode]}</span>
                )}
                {event.count > 1 && (
                  <span className="text-muted-foreground">
                    {' '}
                    · {String(event.count)} раз с {moment(event.first_at)}
                  </span>
                )}
              </TableCell>
              <TableCell className="num text-muted-foreground">{event.ip}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
