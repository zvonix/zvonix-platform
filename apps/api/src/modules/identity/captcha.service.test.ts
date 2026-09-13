/**
 * Поведение проверки «я не робот» — без сети.
 *
 * Сеть подменена намеренно: проверять надо реакцию на ответы Яндекса, включая те,
 * которые вживую не воспроизвести, — отказ сервиса, мусор в теле, таймаут. Главное
 * свойство здесь одно: **недоступная проверка не закрывает вход** (ADR-0031).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@zvonix/shared';
import { CaptchaService } from './captcha.service.js';
import type { CaptchaSettings, SettingsService } from '../settings/settings.service.js';
import type { Logger } from '../../infra/tokens.js';

const silentLogger = (): Logger => {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
};

function build(overrides: Partial<CaptchaSettings> = {}): CaptchaService {
  const captcha: CaptchaSettings = {
    siteKey: 'ysc1_site',
    serverKey: 'ysc2_server',
    onRegister: true,
    onLogin: true,
    onPasswordReset: true,
    ...overrides,
  };
  const settings = { captcha: () => Promise.resolve(captcha) } as unknown as SettingsService;
  return new CaptchaService(settings, silentLogger());
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('когда проверка не нужна', () => {
  it('выключенная форма в сеть не ходит', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await build({ onLogin: false }).assertHuman('login', undefined, '10.0.0.1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('формы различаются по отдельности', async () => {
    const service = build({ onLogin: false, onRegister: true });
    respondWith({ status: 'failed' });

    await service.assertHuman('login', undefined, null);
    await expect(service.assertHuman('register', 'токен', null)).rejects.toThrow(DomainError);
  });

  it('включена без серверного ключа — пропускает, а не закрывает вход', async () => {
    // Иначе опечатка в настройке закрывает вход в систему, а починить его можно
    // только войдя.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await build({ serverKey: '' }).assertHuman('login', undefined, null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ответ сервиса', () => {
  it('status ok пропускает', async () => {
    respondWith({ status: 'ok', message: '', host: 'example.com' });
    await expect(build().assertHuman('login', 'токен', null)).resolves.toBeUndefined();
  });

  it('status failed отвергает', async () => {
    respondWith({ status: 'failed', message: 'Invalid or expired Token.' });
    await expect(build().assertHuman('login', 'токен', null)).rejects.toThrow(DomainError);
  });

  it('робот и просроченный токен получают один ответ', async () => {
    // Различать их наружу незачем, а разница подсказывала бы, как подбирать.
    respondWith({ status: 'failed', message: '' });
    const bot = await build()
      .assertHuman('login', 'токен', null)
      .catch((cause: unknown) => cause);
    respondWith({ status: 'failed', message: 'Invalid or expired Token.' });
    const expired = await build()
      .assertHuman('login', 'токен', null)
      .catch((cause: unknown) => cause);

    expect((bot as DomainError).message).toBe((expired as DomainError).message);
  });
});

describe('недоступная проверка не закрывает вход', () => {
  it('отказ сервиса пропускает', async () => {
    respondWith('', 503);
    await expect(build().assertHuman('login', 'токен', null)).resolves.toBeUndefined();
  });

  it('мусор в теле пропускает', async () => {
    respondWith('не json');
    await expect(build().assertHuman('login', 'токен', null)).resolves.toBeUndefined();
  });

  it('незнакомый статус пропускает', async () => {
    // Сменившийся формат ответа не должен закрывать вход всем сразу.
    respondWith({ status: 'unknown' });
    await expect(build().assertHuman('login', 'токен', null)).resolves.toBeUndefined();
  });

  it('обрыв связи пропускает', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNRESET'))),
    );
    await expect(build().assertHuman('login', 'токен', null)).resolves.toBeUndefined();
  });
});

describe('отсутствующий токен', () => {
  it('отвергается до обращения к сервису', async () => {
    // Ходить в сеть за пустым токеном незачем: ответ известен заранее.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(build().assertHuman('register', undefined, null)).rejects.toThrow(DomainError);
    await expect(build().assertHuman('register', '', null)).rejects.toThrow(DomainError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('что отправляется сервису', () => {
  it('серверный ключ, токен и адрес источника', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await build().assertHuman('login', 'токен-формы', '203.0.113.7');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    const sent = init.body;
    expect(sent.get('secret')).toBe('ysc2_server');
    expect(sent.get('token')).toBe('токен-формы');
    expect(sent.get('ip')).toBe('203.0.113.7');
  });

  it('без известного адреса поле не отправляется', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await build().assertHuman('login', 'токен', null);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(init.body.has('ip')).toBe(false);
  });
});

describe('что отдаётся форме', () => {
  it('без ключей проверка выключена, даже если включена настройкой', async () => {
    // Ключ страницы пуст — виджет нарисовать нечем, и включённость означала бы,
    // что форма ждёт токен, которого взять неоткуда.
    const state = await build({ siteKey: '', serverKey: '' }).publicState();
    expect(state).toMatchObject({ register: false, login: false, password_reset: false });
  });

  it('с ключами показывает, где включена', async () => {
    const state = await build({ onLogin: false }).publicState();
    expect(state).toMatchObject({ site_key: 'ysc1_site', register: true, login: false });
  });
});
