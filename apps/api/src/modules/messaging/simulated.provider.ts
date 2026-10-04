/**
 * Имитация мессенджера: без внешних вызовов, для разработки и проверок
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)). На боевой площадке не выбирается:
 * `MESSENGER_PROVIDER=simulated` задаёт только стенд и тесты.
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MessengerProviderId } from '@zvonix/shared';
import {
  RecipientRejectedError,
  type MessageProvider,
  type ProviderAccountRef,
  type ProviderState,
  type QrResult,
} from './provider.js';

/** Состояния имитированных инстансов: общее на процесс, чтобы проверка могла «отсканировать QR». */
const states = new Map<string, { state: ProviderState; phone: string | null }>();

/** Для проверок: «человек отсканировал QR» либо «аккаунт вышел из MAX». */
export function simulateAccountState(
  instanceId: string,
  state: ProviderState,
  phone: string | null = null,
): void {
  states.set(instanceId, { state, phone });
}

/** Что «отправлено» имитацией: проверка читает отсюда, а не из сети. */
export const simulatedSent: {
  instanceId: string;
  recipient: string;
  text: string;
  messageId: string;
}[] = [];

/** Номера на `0000` имитация считает не имеющими MAX; номера на `9999` — временный сбой. */
const NOT_IN_MESSENGER = /0000$/u;
const TEMPORARY_FAILURE = /9999$/u;

@Injectable()
export class SimulatedMessageProvider implements MessageProvider {
  readonly id: MessengerProviderId = 'simulated';

  createAccount(): Promise<ProviderAccountRef> {
    const instanceId = `sim-${randomUUID().slice(0, 8)}`;
    states.set(instanceId, { state: 'not_authorized', phone: null });
    return Promise.resolve({ instanceId, token: randomUUID(), apiUrl: 'http://provider.invalid' });
  }

  qr(ref: ProviderAccountRef): Promise<QrResult> {
    const known = states.get(ref.instanceId);
    if (known === undefined) return Promise.resolve({ kind: 'unavailable' });
    if (known.state === 'authorized') return Promise.resolve({ kind: 'authorized' });
    return Promise.resolve({ kind: 'qr', image: 'c2ltdWxhdGVkLXFy' });
  }

  state(ref: ProviderAccountRef): Promise<{ state: ProviderState; phone: string | null }> {
    return Promise.resolve(states.get(ref.instanceId) ?? { state: 'unknown', phone: null });
  }

  sendText(
    ref: ProviderAccountRef,
    recipient: string,
    text: string,
  ): Promise<{ messageId: string }> {
    if (NOT_IN_MESSENGER.test(recipient)) {
      return Promise.reject(new RecipientRejectedError('нет аккаунта'));
    }
    if (TEMPORARY_FAILURE.test(recipient)) {
      return Promise.reject(new Error('временный сбой имитации'));
    }
    const messageId = `sim-msg-${randomUUID().slice(0, 12)}`;
    simulatedSent.push({ instanceId: ref.instanceId, recipient, text, messageId });
    return Promise.resolve({ messageId });
  }

  configureWebhook(): Promise<void> {
    return Promise.resolve();
  }

  deleteAccount(ref: ProviderAccountRef): Promise<void> {
    states.delete(ref.instanceId);
    return Promise.resolve();
  }
}
