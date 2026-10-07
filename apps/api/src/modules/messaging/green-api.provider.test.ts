/**
 * Провайдер сообщений против документации Green API для MAX (ADR-0071): адреса, тела запросов, разбор
 * ответов. Сеть подменена; живой проверки этот набор не заменяет — он фиксирует то, что известно из
 * документации, чтобы не расходиться с ней молча.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../infra/tokens.js';
import type { SettingsService } from '../settings/settings.service.js';
import { GreenApiMessageProvider } from './green-api.provider.js';
import { RecipientRejectedError } from './provider.js';

const PARTNER_URL = 'https://api.partner.test';
const PARTNER_TOKEN = 'gac.secret-token';
const REF = { instanceId: '3100000000', token: 'instance-token', apiUrl: 'https://3100.api.test' };

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let calls: Call[] = [];
let respond: (call: Call) => { status?: number; json: unknown } = () => ({ json: {} });

const logger = {
  child: () => logger,
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function provider(token = PARTNER_TOKEN): GreenApiMessageProvider {
  const settings = {
    messaging: () => Promise.resolve({ partnerUrl: PARTNER_URL, partnerToken: token }),
  } as unknown as SettingsService;
  return new GreenApiMessageProvider(settings, logger);
}

beforeEach(() => {
  calls = [];
  respond = () => ({ json: {} });
  vi.stubGlobal('fetch', (url: string, init: { method: string; body?: string }) => {
    const call: Call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const answer = respond(call);
    return Promise.resolve({
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: () => Promise.resolve(answer.json),
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('проверка партнёрского ключа', () => {
  it('список инстансов — ключ принят, считается число аккаунтов', async () => {
    respond = () => ({ json: [{ idInstance: 1 }, { idInstance: 2 }] });
    expect(await provider().checkAccess()).toEqual({ state: 'ok', instances: 2 });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${PARTNER_URL}/partner/getInstances/${PARTNER_TOKEN}`,
    });
  });

  it('неверный ключ провайдер отвечает кодом 200 и ошибкой в теле — это отказ, а не успех', async () => {
    respond = () => ({ json: { code: 401, description: 'Unauthorized' } });
    expect(await provider().checkAccess()).toEqual({ state: 'rejected' });
  });

  it('отказ кодом 4xx — «не принял», сбой сети и 5xx — «нет связи», пустой ключ — «не задан»', async () => {
    respond = () => ({ status: 403, json: {} });
    expect(await provider().checkAccess()).toEqual({ state: 'rejected' });
    respond = () => ({ status: 502, json: {} });
    expect(await provider().checkAccess()).toEqual({ state: 'unreachable' });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('сеть')));
    expect(await provider().checkAccess()).toEqual({ state: 'unreachable' });
    expect(await provider('').checkAccess()).toEqual({ state: 'no_key' });
  });
});

describe('заведение и вход', () => {
  it('createInstance: адрес с косой чертой на конце приводится, данные инстанса возвращаются', async () => {
    respond = () => ({
      json: {
        idInstance: 3100000000,
        apiTokenInstance: 'tok',
        apiUrl: 'https://3100.api.green.test/',
        typeInstance: 'v3',
      },
    });
    expect(await provider().createAccount()).toEqual({
      instanceId: '3100000000',
      token: 'tok',
      apiUrl: 'https://3100.api.green.test',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${PARTNER_URL}/partner/createInstance/${PARTNER_TOKEN}`,
    });
  });

  it('QR-код, «уже вошёл» и ошибка разбираются по полю type', async () => {
    respond = () => ({ json: { type: 'qrCode', message: 'QUJD' } });
    expect(await provider().qr(REF)).toEqual({ kind: 'qr', image: 'QUJD' });
    expect(calls[0]?.url).toBe(`${REF.apiUrl}/waInstance${REF.instanceId}/qr/${REF.token}`);

    respond = () => ({ json: { type: 'already_registered', message: 'x' } });
    expect(await provider().qr(REF)).toEqual({ kind: 'authorized' });

    respond = () => ({ json: { type: 'error', message: 'not_ready' } });
    expect(await provider().qr(REF)).toEqual({ kind: 'unavailable' });

    // Отсканировано, но на аккаунте MAX включён облачный пароль (находка живой пробы 2026-10-07).
    respond = () => ({ json: { type: 'pendingPassword', message: '2FA password required' } });
    expect(await provider().qr(REF)).toEqual({ kind: 'password_required' });
  });

  it.each([
    [{ status: true, data: { status: 'success', reason: '' } }, { accepted: true }],
    [
      { status: true, data: { status: 'success', reason: 'already_registered' } },
      { accepted: true },
    ],
    [
      { status: true, data: { status: 'fail', reason: 'invalid_password' } },
      { accepted: false, reason: 'invalid_password' },
    ],
    [
      { status: true, data: { status: 'fail', reason: 'rate_limit_exceeded' } },
      { accepted: false, reason: 'rate_limit' },
    ],
    [
      { status: true, data: { status: 'fail', reason: 'authorization_not_started' } },
      { accepted: false, reason: 'not_started' },
    ],
    [
      { status: true, data: { status: 'fail', reason: 'timeout' } },
      { accepted: false, reason: 'timeout' },
    ],
    [
      { status: true, data: { status: 'fail', reason: 'что-то новое' } },
      { accepted: false, reason: 'other' },
    ],
  ])('облачный пароль: ответ %j → %j', async (json, expected) => {
    respond = () => ({ json });
    expect(await provider().sendPassword(REF, 'секрет')).toEqual(expected);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${REF.apiUrl}/waInstance${REF.instanceId}/sendAuthorizationPassword/${REF.token}`,
    });
  });

  it.each([
    ['authorized', 'authorized'],
    ['notAuthorized', 'not_authorized'],
    ['blocked', 'blocked'],
    ['suspended', 'suspended'],
    ['starting', 'starting'],
    ['pendingPassword', 'not_authorized'],
    ['что-то новое', 'unknown'],
  ])('состояние %s → %s', async (given, ours) => {
    respond = (call) =>
      call.url.includes('/getSettings/')
        ? { json: { wid: '79990001122@c.us' } }
        : { json: { stateInstance: given } };
    const result = await provider().state(REF);
    expect(result.state).toBe(ours);
    expect(result.phone).toBe(given === 'authorized' ? '79990001122' : null);
  });
});

describe('отправка', () => {
  it('sendMessage: получатель с @c.us, текст как есть, идентификатор сообщения возвращается', async () => {
    respond = () => ({ json: { idMessage: 'abc123' } });
    expect(await provider().sendText(REF, '79001234567', 'Привет')).toEqual({
      messageId: 'abc123',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${REF.apiUrl}/waInstance${REF.instanceId}/sendMessage/${REF.token}`,
      body: { chatId: '79001234567@c.us', message: 'Привет' },
    });
  });

  it('400 — получатель негоден (повтор не поможет); 403 и 5xx — временный сбой, сообщение остаётся в очереди', async () => {
    respond = () => ({ status: 400, json: {} });
    await expect(provider().sendText(REF, '79001234567', 'x')).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
    respond = () => ({ status: 403, json: {} });
    await expect(provider().sendText(REF, '79001234567', 'x')).rejects.not.toBeInstanceOf(
      RecipientRejectedError,
    );
    respond = () => ({ status: 500, json: {} });
    await expect(provider().sendText(REF, '79001234567', 'x')).rejects.not.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it('вебхук: включаются статусы отправленного и смена состояния, входящие выключены', async () => {
    respond = () => ({ json: { saveSettings: true } });
    await provider().configureWebhook(REF, 'https://cp.test/webhooks/messenger/секрет');
    expect(calls[0]).toMatchObject({
      url: `${REF.apiUrl}/waInstance${REF.instanceId}/setSettings/${REF.token}`,
      body: {
        webhookUrl: 'https://cp.test/webhooks/messenger/секрет',
        outgoingWebhook: 'yes',
        stateWebhook: 'yes',
        incomingWebhook: 'no',
      },
    });
  });
});
