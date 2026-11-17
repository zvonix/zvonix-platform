'use client';

import { useQuery } from '@tanstack/react-query';
import type { SmppBindMode, SmppEventKind } from '@zvonix/shared';
import { ErrorNote } from '@/components/error-note';
import { HintText, StatusDot } from '@/components/status-dot';
import { HEAD, NUM, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
  /** Только в журнале площадки: клиент подключения и введённое имя у входа под неизвестным именем. */
  readonly client_name?: string | null;
  readonly system_id?: string | null;
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
  unknown_login: 'Неизвестное имя входа',
  invalid_destination: 'Сообщение: номер не разобран',
  invalid_length: 'Сообщение: пустой или слишком длинный текст',
  wrong_mode: 'Сообщение: вход только для отчётов',
  rejected: 'Сообщение отклонено',
  recipient_not_in_max: 'Сообщение отклонено: у получателя нет MAX',
  recipient_inactive: 'Сообщение отклонено: получатель давно не читает MAX',
  recipient_stopped: 'Сообщение отклонено: получатель ответил «СТОП»',
  duplicate_message: 'Сообщение отклонено: такое же уже принято этому номеру',
  recipient_limit: 'Сообщение отклонено: предел сообщений одному номеру',
  insufficient_funds: 'Сообщение отклонено: не хватает денег на счёте',
  requirements_unmet: 'Сообщение отклонено: под требования к аккаунтам никто не подходит',
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
export function SmppEvents({ url, platform = false }: { url: string; platform?: boolean }) {
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
        {platform
          ? 'Подключений к SMPP не было.'
          : 'Подключений не было: программа к площадке не обращалась.'}
      </p>
    );
  }
  return (
    <div className={`${TABLE_FRAME} ${platform ? 'max-h-[32rem]' : 'max-h-80'} overflow-y-auto`}>
      <Table>
        <TableHeader>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableHead className={HEAD}>Когда</TableHead>
            {platform && <TableHead className={HEAD}>Кто</TableHead>}
            <TableHead className={HEAD}>Что</TableHead>
            <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Раз</TableHead>
            <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Адрес</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.data.events.map((event) => {
            // Итог коротко, подробность после двоеточия и режим входа — в подсказке (строка — одна линия).
            const [label = event.result, detail] = (
              RESULT_NAME[event.result] ?? event.result
            ).split(': ');
            const reason = [
              detail,
              event.kind === 'bind' && event.mode !== null
                ? `режим: ${MODE_NAME[event.mode]}`
                : undefined,
            ]
              .filter((part): part is string => part !== undefined)
              .join('; ');
            return (
              <TableRow key={`${event.first_at}-${event.kind}-${event.result}-${event.ip}`}>
                <TableCell className="num text-muted-foreground">{moment(event.last_at)}</TableCell>
                {platform && (
                  <TableCell>
                    {event.client_name ?? (
                      <span className="num text-warn">{event.system_id ?? '—'}</span>
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <StatusDot
                    tone={event.result === 'ok' ? 'ok' : 'warn'}
                    label={label}
                    reason={reason === '' ? undefined : reason}
                  />
                </TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>
                  {event.count > 1 ? (
                    <HintText
                      label={String(event.count)}
                      reason={`Первый раз ${moment(event.first_at)}`}
                    />
                  ) : (
                    '1'
                  )}
                </TableCell>
                <TableCell className={`num text-muted-foreground ${WIDE_ONLY}`}>
                  {event.ip}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
