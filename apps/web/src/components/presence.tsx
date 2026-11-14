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

/** Связь узла с SIP-провайдером — со слов узла, раз в пульс (ADR-0121). */
export interface TrunkLink {
  readonly state: string;
  readonly status: string;
  readonly reported_at: string;
}

/** Сообщение старше этого — узел молчит, и связь неизвестна. */
const LINK_FRESH_MS = 3 * 60_000;

/** Состояния регистрации sofia-gateway по-русски; неизвестное — как есть. */
const LINK_STATE_NAME: Record<string, string> = {
  REGED: 'зарегистрирован',
  NOREG: 'без регистрации, по адресу',
  TRYING: 'регистрируется',
  REGISTER: 'регистрируется',
  UNREGED: 'не зарегистрирован',
  UNREGISTER: 'снимает регистрацию',
  FAILED: 'регистрация не прошла',
  FAIL_WAIT: 'регистрация не прошла, повторит через 30 с',
  EXPIRED: 'регистрация истекла',
  DOWN: 'выключен',
};

/**
 * На связи ли узел с SIP-провайдером — так же, как шлюз: точка и слово (владелец, 2026-11-15: «показать коннект
 * есть к SIP-провайдеру»). Не на связи — узел не отправит провайдеру ни одного вызова; почему — словами рядом.
 */
export function TrunkPresence({ link, now }: { link: TrunkLink | null; now: number }) {
  const fresh = link !== null && now - Date.parse(link.reported_at) < LINK_FRESH_MS;
  const online = fresh && link.status === 'UP';
  const state = link === null ? undefined : (LINK_STATE_NAME[link.state] ?? link.state);
  const text =
    link === null
      ? 'узел ещё не сообщал'
      : !fresh
        ? 'нет сведений от узла'
        : online
          ? 'на связи'
          : `не на связи · ${state ?? ''}`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${online ? 'text-ok' : 'text-warn'}`}
      title={
        link === null
          ? 'Узел сообщает о связи с провайдерами каждые 30 секунд — после обновления узла'
          : `${state ?? link.state} · ${link.status} · сведения ${moment(link.reported_at)}`
      }
    >
      <span aria-hidden className={`size-2 rounded-full ${online ? 'bg-ok' : 'bg-warn'}`} />
      {text}
    </span>
  );
}
