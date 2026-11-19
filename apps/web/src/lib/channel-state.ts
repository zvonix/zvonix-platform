import type { ChannelStatus, ChannelSuspendedBy } from '@zvonix/shared';
import type { StatusTone } from '../components/status-dot';
import { shortMoment } from './format';

/**
 * Состояние линии клиента — тремя сведениями, по одному на столбец: «Включена», «Подключение», «Последний вызов».
 * Одни на кабинет клиента и админку
 * ([ADR-0101](../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md), п. 1–2 и дополнение
 * от 2026-11-19).
 *
 * История. Сначала рядом стояли «Состояние: Работает» и «Подключение: Не подключена» — «Работает» значило
 * «включена», и это читалось как противоречие. Потом (2026-11-18) их свели в одно слово: «Подключена», «Работает»,
 * «Ждёт программу»… — и стало непонятно, чем «Работает» отличается от «Подключена». Теперь каждое сведение —
 * в своём столбце, и название столбца говорит, о чём ответ (владелец, 2026-11-19).
 */

export interface ChannelStateInput {
  readonly status: ChannelStatus;
  readonly suspended_by: ChannelSuspendedBy | null;
  readonly connection: { readonly connected: boolean; readonly address: string | null };
  /** Последний вызов; поля нет в ответах на правку — тогда считается, что звонков не было. */
  readonly last_call_at?: string | null;
}

/** Кто смотрит: клиенту «выключил клиент» звучит как «выключена вами». */
export type ChannelViewer = 'client' | 'admin';

export interface ChannelFact {
  readonly tone: StatusTone;
  readonly label: string;
  readonly reason?: string;
}

/** Сколько включённая линия может быть без подключения и не тревожить: программа, которая звонит без регистрации. */
export const RECENT_CALL_MS = 24 * 60 * 60 * 1000;

/** «Включена» — можно ли звонить по линии, а если нельзя — кто её выключил. */
export function channelEnabled(channel: ChannelStateInput, viewer: ChannelViewer): ChannelFact {
  switch (channel.status) {
    case 'active':
      return { tone: 'ok', label: 'Да' };
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
          label: viewer === 'client' ? 'Выключена вами' : 'Выключена клиентом',
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

/**
 * «Подключение» — держит ли программа клиента регистрацию на площадке.
 *
 * «Нет» тревожит только у включённой линии, по которой не звонили сутки: программа, которая звонит без постоянного
 * подключения, работает, а выключенной линии подключение и не нужно.
 */
export function channelConnection(
  channel: ChannelStateInput,
  viewer: ChannelViewer,
  now: Date = new Date(),
): ChannelFact {
  const { connected, address } = channel.connection;
  if (connected) {
    if (address === null) return { tone: 'ok', label: 'Есть' };
    return {
      tone: 'ok',
      label: `Есть, с адреса ${hostOf(address)}`,
      reason: `Программа подключена с адреса ${address}`,
    };
  }
  if (channel.status !== 'active') return { tone: 'off', label: 'Нет' };
  if (calledRecently(channel.last_call_at, now)) {
    return {
      tone: 'off',
      label: 'Нет',
      reason: 'Программа звонит без постоянного подключения — так тоже можно',
    };
  }
  return {
    tone: 'warn',
    label: 'Нет',
    reason:
      viewer === 'client'
        ? 'Введите в программе логин и пароль этой линии'
        : 'Программа клиента не подключена и не звонила за последние сутки',
  };
}

/** «Последний вызов» — день и время или прочерк, если звонков не было. */
export function channelLastCall(channel: ChannelStateInput, now: Date = new Date()): string {
  return shortMoment(channel.last_call_at, now);
}

function calledRecently(lastCallAt: string | null | undefined, now: Date): boolean {
  if (lastCallAt === null || lastCallAt === undefined) return false;
  const at = new Date(lastCallAt).getTime();
  return !Number.isNaN(at) && now.getTime() - at <= RECENT_CALL_MS;
}

/**
 * Адрес без порта и способа связи: `94.198.51.21:5060/udp` → `94.198.51.21`; полный адрес — в подсказке.
 * У адреса IPv6 без скобок порт от адреса не отделить — такой показывается целиком.
 */
export function hostOf(address: string): string {
  const withoutProto = address.split('/')[0] ?? address;
  if (withoutProto.startsWith('[')) {
    const end = withoutProto.indexOf(']');
    return end === -1 ? withoutProto : withoutProto.slice(1, end);
  }
  const colons = withoutProto.split(':').length - 1;
  return colons === 1 ? withoutProto.slice(0, withoutProto.indexOf(':')) : withoutProto;
}
