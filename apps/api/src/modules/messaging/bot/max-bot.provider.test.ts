/**
 * Провайдер ботов MAX против документации (https://dev.max.ru/docs-api): тело подписки на события. Сеть подменена.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../infra/tokens.js';
import type { SettingsService } from '../../settings/settings.service.js';
import { MaxBotProvider } from './max-bot.provider.js';

const API_URL = 'https://platform-api.max.test';

const logger = {
  child: () => logger,
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

let requests: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MaxBotProvider.subscribe', () => {
  it('просит и «остановил бота», и «удалил чат»: список — фильтр подписки, без них остановивший оставался подписчиком', async () => {
    const settings = {
      bot: () => Promise.resolve({ apiUrl: API_URL }),
    } as unknown as SettingsService;
    await new MaxBotProvider(settings, logger).subscribe(
      'bot-token',
      'https://cp.test/api/webhooks/max-bot/1',
      'secret-123',
    );

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(`${API_URL}/subscriptions`);
    expect(request?.init.method).toBe('POST');
    const body = JSON.parse(request?.init.body as string) as { update_types: string[] };
    expect(body.update_types).toEqual(
      expect.arrayContaining(['bot_started', 'message_created', 'bot_stopped', 'dialog_removed']),
    );
  });
});
