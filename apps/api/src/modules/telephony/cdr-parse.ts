/**
 * Разбор CDR от `mod_json_cdr` (docs/api/node.md).
 *
 * Форма задана FreeSWITCH и потому уродлива: числа приходят строками, имена полей
 * не в нашем стиле, состав меняется от версии к версии. Разбор изолирован здесь, чтобы
 * дальше по коду ездила понятная запись, а не сырое тело чужого модуля.
 *
 * Проверяется только то, без чего нельзя тарифицировать. Строгая проверка «лишних полей
 * нет» ломала бы приём CDR при обновлении узла, а несписанный вызов — это потерянные
 * деньги, в отличие от лишнего поля.
 */

import type { CallStatus } from '@zvonix/shared';

/** Что нужно от CDR, чтобы закрыть вызов и списать деньги. */
export interface ParsedCdr {
  /** Идентификатор вызова на узле. У плеча A совпадает с тем, что было в запросе маршрута. */
  readonly uuid: string;
  /**
   * Наш идентификатор вызова, экспортированный диалпланом на оба плеча.
   * По нему опознаётся плечо B, которое тарифицировать нельзя.
   */
  readonly zvonixCallId: string | undefined;
  /** Оплачиваемые секунды: от ответа до отбоя. Ноль, если не ответили. */
  readonly billableSeconds: number;
  readonly hangupCause: string;
  readonly answeredAt: Date | undefined;
  readonly endedAt: Date | undefined;
  /** Причина отказа, которую control plane сам же и проставил при маршрутизации. */
  readonly rejectReason: string | undefined;
  /**
   * Идентификатор тестового звонка, если это он
   * ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)): вызов вне биллинга.
   */
  readonly testCallId: string | undefined;
  /**
   * Код SIP ответа шлюза: отказ на INVITE (`sip_invite_failure_status`), иначе код,
   * которым закончилось плечо (`sip_term_status`).
   */
  readonly sipStatus: string | undefined;
  /** Текст этого ответа, как его прислал шлюз: «Service Unavailable», «Not Found». */
  readonly sipPhrase: string | undefined;
  /** Когда шлюз сообщил, что набирает (`180`/`183`). Пусто — до набора не дошло. */
  readonly progressAt: Date | undefined;
}

export class CdrParseError extends Error {
  override readonly name = 'CdrParseError';
}

/**
 * Достаёт из тела CDR то, что нужно.
 *
 * `mod_json_cdr` кладёт всё интересное в `variables`. Значения там строковые —
 * включая длительности, поэтому разбор чисел явный, а не через приведение типов.
 */
export function parseCdr(body: unknown): ParsedCdr {
  if (typeof body !== 'object' || body === null) {
    throw new CdrParseError('Тело CDR не является объектом');
  }

  const variables = (body as { variables?: unknown }).variables;
  if (typeof variables !== 'object' || variables === null) {
    throw new CdrParseError('В CDR нет раздела variables');
  }
  const source = variables as Record<string, unknown>;

  const uuid = text(source['uuid']);
  if (uuid === undefined) {
    throw new CdrParseError('В CDR нет идентификатора вызова');
  }

  return {
    uuid,
    zvonixCallId: text(source['zvonix_call_id']),
    // `billsec` — время от ответа до отбоя. `duration` включает дозвон и тарификации
    // не подлежит: гудки клиент не оплачивает.
    billableSeconds: seconds(source['billsec']),
    hangupCause: text(source['hangup_cause']) ?? 'UNSPECIFIED',
    answeredAt: stamp(source['answer_stamp']),
    endedAt: stamp(source['end_stamp']),
    rejectReason: text(source['zvonix_reject_reason']),
    testCallId: text(source['zvonix_test_call']),
    sipStatus: text(source['sip_invite_failure_status']) ?? text(source['sip_term_status']),
    sipPhrase: text(source['sip_invite_failure_phrase']) ?? text(source['sip_term_phrase']),
    progressAt: stamp(source['progress_stamp']) ?? stamp(source['progress_media_stamp']),
  };
}

/**
 * Итог вызова по причине отбоя FreeSWITCH.
 *
 * Разделение не косметическое: тарифицируется только `completed`, а `busy` и `no_answer`
 * входят в расчёт ASR по-разному — занято означает, что абонент есть, а молчание
 * может означать, что SIM не проходит в сеть.
 */
export function statusFromHangupCause(cause: string, billableSeconds: number): CallStatus {
  if (billableSeconds > 0) {
    // Разговор состоялся. Чем он закончился — уже не про тарификацию: платят за минуты.
    return 'completed';
  }

  switch (cause) {
    case 'USER_BUSY':
      return 'busy';
    case 'NO_ANSWER':
    case 'NO_USER_RESPONSE':
    case 'ALLOTTED_TIMEOUT':
      return 'no_answer';
    case 'ORIGINATOR_CANCEL':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Целые секунды из строкового поля.
 *
 * Отрицательное и нечисловое значение даёт ноль, а не ошибку: несписанный вызов —
 * потерянные деньги, и ронять приём CDR из-за неразобранного поля хуже, чем принять
 * его как неотвеченный. Расхождение при этом видно в сверке.
 */
function seconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number.parseInt(text(value) ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Отметка времени FreeSWITCH: `2026-09-02 07:15:42.123456`.
 *
 * Пояс в ней не указан, а сам узел работает в UTC — это требование конфигурации узла,
 * записанное в контракте. Значение `0000-00-00 00:00:00` означает «события не было»
 * (не ответили) и превращается в `undefined`, а не в 1970 год.
 */
function stamp(value: unknown): Date | undefined {
  const raw = text(value);
  if (raw === undefined || raw.startsWith('0000')) return undefined;
  const parsed = new Date(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
