import { moment } from '@/lib/format';

/** Подключение шлюза или линии GOIP — по опросу узлов (ADR-0103); одно у партнёра и в админке. */
export interface DeviceConnection {
  readonly connected: boolean;
  readonly seen_at: string | null;
  /** Откуда устройство вошло; только пока подключено. */
  readonly address: string | null;
  /** Когда устройство последний раз стучалось — и с неверным паролем тоже. */
  readonly knocked_at: string | null;
  /** Не подключено, но стучалось недавно — скорее всего, неверный пароль. */
  readonly rejected: boolean;
}

/**
 * На связи ли устройство: точка и слово одного цвета — зелёный «да», жёлтый «нет»
 * (владелец, 2026-09-29: «на связи может писать другим цветом»). Слово остаётся: один цвет не читается
 * при нарушенном цветовосприятии. Стучится, но не вошло — подсказка про пароль: это самая частая причина.
 */
export function Presence({ connection }: { connection: DeviceConnection }) {
  const online = connection.connected;
  const title = online
    ? [
        connection.address,
        connection.seen_at === null ? null : `видели ${moment(connection.seen_at)}`,
      ]
        .filter((part) => part !== null)
        .join(' · ')
    : connection.knocked_at === null
      ? 'Устройство ещё ни разу не обращалось к площадке'
      : connection.rejected
        ? `Обращалось ${moment(connection.knocked_at)}, но не вошло — обычно это неверное имя или пароль`
        : `Последний раз обращалось ${moment(connection.knocked_at)}`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${online ? 'text-ok' : 'text-warn'}`}
      title={title}
    >
      <span aria-hidden className={`size-2 rounded-full ${online ? 'bg-ok' : 'bg-warn'}`} />
      {online ? 'на связи' : connection.rejected ? 'не на связи · проверьте пароль' : 'не на связи'}
    </span>
  );
}
