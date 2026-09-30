/**
 * Сборка диалплана FreeSWITCH (docs/api/node.md).
 *
 * **Ответ всегда 200 и всегда валидный XML.** Любой другой код `mod_xml_curl` отбрасывает
 * целиком и пишет ошибку в лог — абонент услышит невнятный отбой вместо причины. Поэтому
 * отказ выражается диалпланом, который кладёт трубку с внятным кодом SIP, а не кодом HTTP.
 */

import type { CallFailureReason, TerminationKind } from '@zvonix/shared';
import { simBridgeEndpoint } from '../telephony/sim-dial.js';
import { escapeXmlAttribute } from '../telephony/sip-credentials.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';

/** Контекст диалплана, в котором узел исполняет полученное решение. */
const CONTEXT = 'zvonix';

/**
 * Причины, по которым узел пробует следующего кандидата, а не прекращает перебор.
 *
 * Занято и не отвечают — свойства абонента, а не шлюза, но перебирать по ним всё равно
 * нужно: у другого партнёра может быть другой маршрут до того же номера.
 */
const CONTINUE_ON_FAIL = [
  'NO_ANSWER',
  'USER_BUSY',
  'NO_USER_RESPONSE',
  'NORMAL_TEMPORARY_FAILURE',
  'NETWORK_OUT_OF_ORDER',
  'RECOVERY_ON_TIMER_EXPIRE',
].join(',');

interface RouteCandidate {
  /**
   * Через что набирать.
   *
   * `sim` — GOIP или телефон: он **зарегистрирован у нас**, и набор идёт через
   * зарегистрированного пользователя.
   * `sip` — транк: регистрируемся у провайдера **мы**, и набор идёт через исходящий
   * sofia-gateway с тем же именем
   * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
   */
  readonly kind: TerminationKind;

  /**
   * Учётная запись, которую набирать: шлюза (`gw-…`) или, при входе по линиям, порта
   * (`pt-…`, [ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
   * У транка — имя sofia-gateway.
   */
  readonly sipUsername: string;

  /**
   * Префикс линии GOIP, по которому шлюз выбирает, с какой SIM звонить
   * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md)). Пусто —
   * выбирать нечего: линию уже выбрал вход линии (ADR-0054), у телефона Android слот
   * один, у транка SIM нет вовсе.
   */
  readonly linePrefix: string | null;
}

export interface RoutePlan {
  readonly callId: string;
  readonly destination: string;
  readonly candidates: readonly RouteCandidate[];
  /** Куда писать разговор. Пусто — запись каналом не требуется. */
  readonly recordingPath: string | null;
  /** Номер, который увидит вызываемый. Пусто — номер SIM. */
  readonly callerId: string | null;
  readonly realm: string;
}

/**
 * Как отказ выглядит для звонящего.
 *
 * Коды намеренно грубее причин: сообщать звонящему, что у клиента кончились деньги
 * или что номер в чёрном списке, не следует. Точная причина уходит в переменную канала
 * и возвращается в CDR — её видит поддержка.
 */
const SIP_RESPONSE: Readonly<Record<CallFailureReason, string>> = {
  channel_unknown: '403 Forbidden',
  // «Такого номера у нас нет» — и для короткого, и для экстренного, и для мусора:
  // код намеренно грубее причины, как и все остальные (ADR-0042).
  destination_invalid: '404 Not Found',
  operator_unconfirmed: '404 Not Found',
  destination_blocked: '403 Forbidden',
  operator_not_allowed: '403 Forbidden',
  no_tariff: '503 Service Unavailable',
  insufficient_funds: '402 Payment Required',
  limit_exceeded: '503 Service Unavailable',
  no_sim_available: '503 Service Unavailable',
  gateway_unregistered: '503 Service Unavailable',
  recording_required: '503 Service Unavailable',
  no_coverage: '503 Service Unavailable',
  node_lost: '503 Service Unavailable',
  internal_error: '503 Service Unavailable',
};

export function sipResponseFor(reason: CallFailureReason): string {
  return SIP_RESPONSE[reason];
}

/**
 * Диалплан с упорядоченным списком кандидатов.
 *
 * Кандидаты уезжают одним `bridge` через `|`: перебор выполняет узел. Это ровно то, чего
 * от него хотят, и ради чего решение не превращается в серию обращений к control plane
 * на каждую неудачную попытку.
 *
 * Обращение идёт к `user/<имя>@<realm>` — зарегистрированной учётной записи каталога.
 * Не `sofia/gateway/…`: в терминах FreeSWITCH «gateway» это транк, на который
 * регистрируемся мы, а GOIP партнёра регистрируется **на узле**.
 *
 * Кандидаты могут стоять на одном шлюзе: префикс линии делает их разными попытками,
 * а не одним и тем же набором, повторённым несколько раз.
 */
export function routeDocument(plan: RoutePlan): string {
  const bridge = plan.candidates.map((candidate) => endpointOf(candidate, plan)).join('|');

  const actions: string[] = [
    action('set', 'hangup_after_bridge=true'),
    action('set', `continue_on_fail=${CONTINUE_ON_FAIL}`),
    // Идентификатор вызова экспортируется на исходящее плечо: без него связать
    // разговор, деньги и запись нечем.
    action('export', `nolocal:zvonix_call_id=${plan.callId}`),
  ];

  if (plan.callerId !== null) {
    actions.push(action('set', `effective_caller_id_number=${plan.callerId}`));
  }
  if (plan.recordingPath !== null) {
    actions.push(action('set', 'RECORD_STEREO=true'), action('record_session', plan.recordingPath));
  }

  actions.push(action('bridge', bridge), action('hangup'));

  return document('zvonix-route', actions);
}

/**
 * Как набрать кандидата.
 *
 * Две записи, потому что стороны разные. GOIP регистрируется **у нас** — он значится
 * в каталоге, и набор идёт через него как через пользователя. К провайдеру
 * регистрируемся **мы** — он значится в конфигурации узла исходящим sofia-gateway,
 * и набор идёт через шлюз с номером назначения.
 *
 * Зарегистрированный шлюз набирается адресом его регистрации, а номер с префиксом линии
 * стоит в самой строке (`simBridgeEndpoint`): переменная плеча `zvonix_dial` из `bridge`
 * до строки набора каталога не доходит (живой узел, 2026-09-30).
 */
function endpointOf(candidate: RouteCandidate, plan: RoutePlan): string {
  if (candidate.kind === 'sip') {
    const name = escapeXmlAttribute(candidate.sipUsername);
    return `sofia/gateway/${name}/${escapeXmlAttribute(plan.destination)}`;
  }
  // Без экранирования здесь: `action` экранирует значение целиком сам.
  return simBridgeEndpoint(
    { sipUsername: candidate.sipUsername, linePrefix: candidate.linePrefix },
    plan.destination,
    plan.realm,
  );
}

/** Отказ: тот же 200 и тот же XML, просто диалплан кладёт трубку. */
export function rejectDocument(reason: CallFailureReason): string {
  return document('zvonix-reject', [
    // Причина остаётся переменной канала и приезжает обратно в CDR.
    action('set', `zvonix_reject_reason=${reason}`),
    action('respond', sipResponseFor(reason)),
  ]);
}

function action(application: string, data?: string): string {
  const payload = data === undefined ? '' : ` data="${escapeXmlAttribute(data)}"`;
  return `          <action application="${escapeXmlAttribute(application)}"${payload}/>`;
}

function document(extension: string, actions: readonly string[]): string {
  return [
    HEADER,
    '<document type="freeswitch/xml">',
    '  <section name="dialplan">',
    `    <context name="${CONTEXT}">`,
    `      <extension name="${extension}">`,
    '        <condition>',
    ...actions,
    '        </condition>',
    '      </extension>',
    '    </context>',
    '  </section>',
    '</document>',
  ].join('\n');
}
