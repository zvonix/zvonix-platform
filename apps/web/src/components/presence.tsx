import { StatusDot } from '@/components/status-dot';
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
export function Presence({
  connection,
  dotOnly = false,
}: {
  connection: DeviceConnection;
  /** Только точка, слово — в подсказке: в столбце, где связь повторяется в каждой строке. */
  dotOnly?: boolean;
}) {
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
  // Причина — в подсказке, а не хвостом в строке: строка таблицы остаётся в одну линию (DESIGN.md, «Таблица»).
  return (
    <StatusDot
      tone={online ? 'ok' : 'warn'}
      label={online ? 'на связи' : 'не на связи'}
      reason={title === '' ? undefined : title}
      dotOnly={dotOnly}
    />
  );
}

/** Связь узла с SIP-провайдером — со слов узла, раз в пульс (ADR-0121). */
export interface TrunkLink {
  readonly state: string;
  readonly status: string;
  /** Код последнего отказа регистрации (403, 404…; 908 — провайдер не ответил); пусто — отказов нет. */
  readonly failure?: number | null;
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
 * Состояние словами. «Регистрируется» при неготовом транке — это не «вот-вот», а «провайдер молчит»: при неверном
 * пароле он отказал бы (FAIL_WAIT), а здесь запрос регистрации остаётся без ответа (владелец, 2026-11-15, plusofon).
 */
function linkStateName(link: TrunkLink): string {
  if (link.status !== 'UP' && link.failure != null) {
    return failureName(link.failure).short;
  }
  if (link.status !== 'UP' && (link.state === 'TRYING' || link.state === 'REGISTER')) {
    return 'провайдер не отвечает на регистрацию';
  }
  return LINK_STATE_NAME[link.state] ?? link.state;
}

/**
 * Отказ регистрации словами: коротко — в строку, что делать — в подсказку (владелец, 2026-11-15: «неправильный пароль
 * или нет связи совсем — нельзя узнать и вывести?»). 908 — так FreeSWITCH зовёт истёкшее ожидание ответа.
 */
function failureName(code: number): { short: string; hint: string } {
  switch (code) {
    case 401:
    case 403:
    case 407:
      return {
        short: 'неверный логин или пароль',
        hint: 'Проверьте логин и пароль в настройках провайдера',
      };
    case 404:
      return {
        short: 'нет такой учётной записи',
        hint: 'Провайдер не знает этот логин — проверьте его в настройках провайдера',
      };
    case 408:
    case 908:
      return {
        short: 'провайдер не отвечает',
        hint: 'Узел отправляет провайдеру запрос и не получает ответа. Проверьте у провайдера, разрешён ли адрес узла и не заблокирован ли он',
      };
    case 503:
      return {
        short: 'провайдер временно недоступен',
        hint: 'Узел повторит регистрацию через 30 секунд',
      };
    default:
      return {
        short: `провайдер отказал, код ${String(code)}`,
        hint: 'Код ответа провайдера — уточните его значение у провайдера',
      };
  }
}

/**
 * На связи ли узел с SIP-провайдером — так же, как шлюз и линия (владелец, 2026-11-15: «показать коннект есть
 * к SIP-провайдеру»). В строке таблицы — одной точкой рядом с названием, слово и причина — в подсказке, открывается
 * и нажатием (DESIGN.md, «Таблица»; владелец, 2026-11-17). Не на связи — узел не отправит провайдеру ни одного вызова.
 */
export function TrunkPresence({
  link,
  now,
  dotOnly = false,
}: {
  link: TrunkLink | null;
  now: number;
  dotOnly?: boolean;
}) {
  const fresh = link !== null && now - Date.parse(link.reported_at) < LINK_FRESH_MS;
  const online = fresh && link.status === 'UP';
  const state = link === null ? undefined : linkStateName(link);
  const text = link === null || !fresh ? 'нет сведений' : online ? 'на связи' : 'не на связи';
  const reason =
    link === null
      ? 'Узел ещё не сообщал о связи с провайдером: он сообщает каждые 30 секунд, если провайдер включён'
      : [
          ...(fresh ? [] : ['Сведения устарели — узел молчит или провайдер выключен. Последние']),
          state ?? link.state,
          link.status === 'UP' ? 'вызовы принимает' : 'вызовы не принимает',
          ...(link.status !== 'UP' && link.failure != null
            ? [`${failureName(link.failure).hint} (код ${String(link.failure)})`]
            : []),
          `сведения ${moment(link.reported_at)}`,
        ].join(' · ');
  return (
    <StatusDot
      tone={online ? 'ok' : link === null || !fresh ? 'off' : 'warn'}
      label={text}
      reason={reason}
      dotOnly={dotOnly}
    />
  );
}
