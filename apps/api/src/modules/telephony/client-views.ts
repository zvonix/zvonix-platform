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

import {
  clientFailureReasonOf,
  type CallStatus,
  type ChannelStatus,
  type ChannelSuspendedBy,
} from '@zvonix/shared';
import type { ClientFailureReason } from '@zvonix/shared';
import type { ChannelActivity } from './call.repository.js';
import type { CallDetails } from './calls.service.js';
import { isRegistered } from './registrations.service.js';
import type { ChannelRow } from './telephony.repository.js';

/**
 * Канал в клиентском ответе.
 *
 * Пароля здесь нет и не будет: в базе хеш. Имя учётной записи есть
 * ([ADR-0101](../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md)): без него клиент,
 * потерявший листок с выдачей, не настроил бы программу, а секрета в имени нет.
 *
 * `caller_id` в кабинете больше не показывается, но из ответа не уходит — контракт `/v1` поля не теряет.
 */
export interface ClientChannelView {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  /** Кто выключил: `client` — включит сам, `admin` — только площадка. */
  readonly suspended_by: ChannelSuspendedBy | null;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
  readonly comment: string | null;
  readonly max_concurrent_calls: number | null;
  readonly sip_username: string;
  /** Подключена ли программа — по регистрации на узле (ADR-0101, п. 1). */
  readonly connection: {
    readonly connected: boolean;
    /** Когда опрос видел регистрацию последний раз. */
    readonly seen_at: string | null;
    /** Откуда программа зарегистрировалась: `адрес:порт/транспорт`. */
    readonly address: string | null;
  };
  /** Разговоров идёт сейчас и последний вызов — только в списке. */
  readonly open_calls?: number;
  readonly last_call_at?: string | null;
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

export function toClientChannelView(
  row: ChannelRow,
  now: Date,
  activity?: ChannelActivity,
): ClientChannelView {
  const connected = isRegistered(row, now);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    suspended_by: row.suspendedBy,
    recording_required: row.recordingRequired,
    caller_id: row.callerId,
    comment: row.comment,
    max_concurrent_calls: row.maxConcurrentCalls,
    sip_username: row.sipUsername,
    connection: {
      connected,
      seen_at: row.registrationSeenAt?.toISOString() ?? null,
      address: row.registrationAddress,
    },
    ...(activity === undefined
      ? {}
      : { open_calls: activity.open, last_call_at: activity.lastCallAt?.toISOString() ?? null }),
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
