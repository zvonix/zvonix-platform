/**
 * Имитация мессенджера: без внешних вызовов, для разработки и проверок
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)). На боевой площадке не выбирается:
 * `MESSENGER_PROVIDER=simulated` задаёт только стенд и тесты.
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MessengerProviderId } from '@zvonix/shared';
import type { MessageProvider, ProviderAccountRef, ProviderState, QrResult } from './provider.js';

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

  deleteAccount(ref: ProviderAccountRef): Promise<void> {
    states.delete(ref.instanceId);
    return Promise.resolve();
  }
}
