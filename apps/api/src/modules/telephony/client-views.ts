/**
 * Как клиент видит свои линии и вызовы — **одно описание на кабинет и на API**.
 *
 * Правило приватности здесь одно ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)):
 * ни партнёра, ни шлюза, ни SIM, ни псевдонима — ни в кабинете, ни в `/v1`. Два описания
 * этого правила разошлись бы на первой же правке, и разошлись бы молча: пропущенное поле
 * не ломает ни типов, ни проверок, оно просто утекает.
 *
 * Отсюда же обязательство перед `/v1` ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)):
 * поле здесь может появиться, но не исчезнуть и не поменять смысл. Понадобится убрать —
 * значит контуры пора развести, а не править это на месте.
 */

import { clientFailureReasonOf, type CallStatus, type ChannelStatus } from '@zvonix/shared';
import type { ClientFailureReason } from '@zvonix/shared';
import type { CallDetails } from './calls.service.js';
import type { ChannelRow } from './telephony.repository.js';

/**
 * Канал в клиентском ответе.
 *
 * Учётных данных SIP здесь нет: пароль восстановить неоткуда, а имя пользователя клиент
 * и так держит в настройках своей АТС. Показывать его — лишняя копия того, что уже
 * настроено, и лишний повод считать её источником правды.
 */
export interface ClientChannelView {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
}

/**
 * Вызов так, как его видит клиент.
 *
 * **Ни партнёра, ни шлюза, ни SIM** — ни в каком виде, включая псевдоним. Через кого
 * ушёл конкретный вызов — открытый вопрос владельца («что клиент видит про партнёра»),
 * и до ответа на него в клиентский контур не уходит ничего.
 *
 * Причина отказа переведена в клиентский набор: часть причин говорит о нашей стороне,
 * и по ним читалась бы ёмкость площадки (`clientFailureReasonOf`).
 */
export interface ClientCallView {
  readonly id: string;
  readonly destination: string;
  readonly status: CallStatus;
  readonly failure_reason: ClientFailureReason | null;
  readonly duration_seconds: number | null;
  readonly started_at: string;
  readonly answered_at: string | null;
  readonly ended_at: string | null;
  readonly region: string | null;
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
}

export function toClientChannelView(row: ChannelRow): ClientChannelView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    recording_required: row.recordingRequired,
    caller_id: row.callerId,
  };
}

export function toClientCallView(row: CallDetails): ClientCallView {
  const call = row.call;
  return {
    id: call.id,
    destination: call.destination,
    status: call.status,
    failure_reason: call.failureReason === null ? null : clientFailureReasonOf(call.failureReason),
    duration_seconds: call.durationSeconds,
    started_at: call.startedAt.toISOString(),
    answered_at: call.answeredAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    region: call.region,
    channel: { id: call.channelId, name: row.channelName },
    operator:
      call.operatorId === null || row.operatorName === null
        ? null
        : { id: call.operatorId, name: row.operatorName },
  };
}
