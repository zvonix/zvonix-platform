import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EslError, eslApi } from './esl.js';

/**
 * Поддельный FreeSWITCH: ведёт разговор по сценарию. Настоящий протокол тот же —
 * заголовки, пустая строка, тело по `Content-Length`.
 */
type Script = (socket: Socket, received: string[]) => void;

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
});

async function fakeEsl(script: Script): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  server = createServer((socket) => {
    socket.on('data', (chunk) => {
      received.push(chunk.toString('utf8'));
    });
    script(socket, received);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

function message(headers: Record<string, string>, body = ''): string {
  const bytes = Buffer.byteLength(body, 'utf8');
  const all = bytes > 0 ? { ...headers, 'Content-Length': String(bytes) } : headers;
  const head = Object.entries(all)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `${head}\n\n${body}`;
}

/** Штатный сервер: просит пароль, принимает его и отвечает на команду телом `reply`. */
function honest(reply: string, password = 'secret'): Script {
  return (socket, received) => {
    socket.write(message({ 'Content-Type': 'auth/request' }));
    socket.on('data', () => {
      const all = received.join('');
      if (all.includes('api ') && !all.includes('exit')) {
        socket.write(message({ 'Content-Type': 'api/response' }, reply));
      } else if (all.startsWith('auth ') && !all.includes('api ')) {
        const ok = all.startsWith(`auth ${password}\n\n`);
        socket.write(
          message({
            'Content-Type': 'command/reply',
            'Reply-Text': ok ? '%2BOK accepted' : '-ERR invalid',
          }),
        );
        if (!ok) socket.end();
      }
    });
  };
}

describe('клиент ESL', () => {
  it('предъявляет пароль, отдаёт команду и возвращает тело ответа', async () => {
    const esl = await fakeEsl(honest('+OK 5f1c7d2e-0000-4000-8000-000000000001\n'));
    const reply = await eslApi(
      { host: '127.0.0.1', port: esl.port, password: 'secret' },
      'originate user/pt-abc@realm &park()',
      { timeoutMs: 2_000 },
    );
    expect(reply).toBe('+OK 5f1c7d2e-0000-4000-8000-000000000001');
    const sent = esl.received.join('');
    expect(sent).toContain('auth secret\n\n');
    expect(sent).toContain('api originate user/pt-abc@realm &park()\n\n');
  });

  it('тело с кириллицей читается по байтам, а не по символам', async () => {
    const esl = await fakeEsl(honest('-ERR Абонент недоступен'));
    const reply = await eslApi(
      { host: '127.0.0.1', port: esl.port, password: 'secret' },
      'status',
      {
        timeoutMs: 2_000,
      },
    );
    expect(reply).toBe('-ERR Абонент недоступен');
  });

  it('пропускает служебные сообщения между паролем и ответом', async () => {
    const esl = await fakeEsl((socket, received) => {
      socket.write(message({ 'Content-Type': 'auth/request' }));
      socket.on('data', () => {
        const all = received.join('');
        if (all.includes('api ') && !all.includes('exit')) {
          // Уведомление и ответ одним пакетом — разбор обязан их разделить.
          socket.write(
            message({ 'Content-Type': 'log/data' }, 'шум') +
              message({ 'Content-Type': 'api/response' }, '+OK'),
          );
        } else if (!all.includes('api ')) {
          socket.write(message({ 'Content-Type': 'command/reply', 'Reply-Text': '+OK accepted' }));
        }
      });
    });
    await expect(
      eslApi({ host: '127.0.0.1', port: esl.port, password: 'secret' }, 'status', {
        timeoutMs: 2_000,
      }),
    ).resolves.toBe('+OK');
  });

  it('неверный пароль — отказ «auth»', async () => {
    const esl = await fakeEsl(honest('+OK', 'другой'));
    await expect(
      eslApi({ host: '127.0.0.1', port: esl.port, password: 'secret' }, 'status', {
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ failure: 'auth' });
  });

  it('молчащий сервер — отказ по сроку, а не вечное ожидание', async () => {
    const esl = await fakeEsl((socket) => {
      socket.write(message({ 'Content-Type': 'auth/request' }));
    });
    await expect(
      eslApi({ host: '127.0.0.1', port: esl.port, password: 'secret' }, 'status', {
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('закрытый порт — отказ «connect»', async () => {
    const esl = await fakeEsl(() => undefined);
    const port = esl.port;
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = undefined;
    await expect(
      eslApi({ host: '127.0.0.1', port, password: 'secret' }, 'status', { timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ failure: 'connect' });
  });

  it('обрыв соединения до ответа — отказ, а не зависание', async () => {
    const esl = await fakeEsl((socket) => {
      socket.write(message({ 'Content-Type': 'auth/request' }));
      socket.end();
    });
    await expect(
      eslApi({ host: '127.0.0.1', port: esl.port, password: 'secret' }, 'status', {
        timeoutMs: 2_000,
      }),
    ).rejects.toBeInstanceOf(EslError);
  });

  it('перевод строки в команде не уходит на сервер', async () => {
    const esl = await fakeEsl(honest('+OK'));
    await expect(
      eslApi({ host: '127.0.0.1', port: esl.port, password: 'secret' }, 'status\n\napi shutdown', {
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ failure: 'protocol' });
    expect(esl.received).toEqual([]);
  });
});
