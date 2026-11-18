import type { ChannelStatus, ChannelSuspendedBy } from '@zvonix/shared';
import type { StatusTone } from '@/components/status-dot';
import { moment } from '@/lib/format';

/**
 * Состояние линии клиента одним словом — одно на кабинет клиента и админку
 * ([ADR-0101](../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md), п. 1–2).
 *
 * Раньше рядом стояли две колонки: «Состояние: Работает» и «Подключение: Не подключена». Владелец назвал это
 * нелогичным (2026-11-18): для работающей линии важен один ответ — звонит ли она. Поэтому у работающей линии слово
 * берётся из подключения и вызовов, у остальных — из состояния. Подробности в подсказке.
 */

export interface ChannelStateInput {
  readonly status: ChannelStatus;
  readonly suspended_by: ChannelSuspendedBy | null;
  readonly connection: { readonly connected: boolean; readonly address: string | null };
  /** Последний вызов — есть только в списке; без него «Работает» не отличить от «Ждёт программу». */
  readonly last_call_at?: string | null;
}

/** Кто смотрит: клиенту «выключил клиент» звучит как «выключена». */
export type ChannelViewer = 'client' | 'admin';

export function channelState(
  channel: ChannelStateInput,
  viewer: ChannelViewer,
): { tone: StatusTone; label: string; reason?: string } {
  switch (channel.status) {
    case 'active': {
      if (channel.connection.connected) {
        return {
          tone: 'ok',
          label: 'Подключена',
          ...(channel.connection.address === null
            ? {}
            : { reason: `Программа подключена с адреса ${channel.connection.address}` }),
        };
      }
      if (channel.last_call_at != null) {
        return {
          tone: 'ok',
          label: 'Работает',
          reason: `Последний вызов ${moment(channel.last_call_at)}. Программа звонит без постоянного подключения — так тоже можно`,
        };
      }
      return {
        tone: 'warn',
        label: 'Ждёт программу',
        reason:
          viewer === 'client'
            ? 'Введите в программе логин и пароль этой линии'
            : 'Программа клиента ещё не подключалась и не звонила',
      };
    }
    case 'pending':
      return {
        tone: 'warn',
        label: viewer === 'client' ? 'Ждёт площадку' : 'Ждёт включения',
        reason:
          viewer === 'client'
            ? 'Линию ещё не включила площадка — звонить по ней пока нельзя'
            : 'Линию завела площадка и ещё не включила',
      };
    case 'suspended':
      if (channel.suspended_by === 'client') {
        return {
          tone: 'off',
          label: viewer === 'client' ? 'Выключена' : 'Выключена клиентом',
          reason:
            viewer === 'client'
              ? 'Вызовы не идут; включить можно на странице линии'
              : 'Клиент выключил линию сам в своём кабинете',
        };
      }
      return {
        tone: 'crit',
        label: 'Выключена площадкой',
        reason:
          viewer === 'client'
            ? 'Вызовы не идут; включить её может только площадка — напишите в поддержку'
            : 'Вызовы не идут; клиент сам её не включит',
      };
    case 'closed':
      return { tone: 'off', label: 'Удалена', reason: 'Линия удалена навсегда' };
  }
}
