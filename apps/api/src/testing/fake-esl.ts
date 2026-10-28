/**
 * Поддельный ESL узла для наборов с базой: принимает пароль и отвечает на `api …` тем, что вернёт `reply`.
 *
 * Один на все наборы, которым нужен узел без живого FreeSWITCH: пробный звонок (ADR-0055) и опрос регистраций
 * линий (ADR-0101). Две копии разошлись бы на первой правке протокола.
 */

import { createServer, type AddressInfo, type Server } from 'node:net';

function frame(headers: Record<string, string>, body = ''): string {
  const length = Buffer.byteLength(body, 'utf8');
  const all = length > 0 ? { ...headers, 'Content-Length': String(length) } : headers;
  return (
    Object.entries(all)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') + `\n\n${body}`
  );
}

export class FakeEsl {
  /** Команды `api`, полученные узлом, по порядку. */
  readonly commands: string[] = [];
  private server: Server | undefined;
  private listening = 0;

  constructor(
    readonly password: string,
    /** Ответ на команду; меняется между проверками. */
    public reply: (command: string) => string,
  ) {}

  get port(): number {
    return this.listening;
  }

  async start(): Promise<void> {
    const server = createServer((socket) => {
      let received = '';
      socket.write(frame({ 'Content-Type': 'auth/request' }));
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
        for (;;) {
          const end = received.indexOf('\n\n');
          if (end === -1) return;
          const line = received.slice(0, end);
          received = received.slice(end + 2);
          if (line.startsWith('auth ')) {
            const ok = line === `auth ${this.password}`;
            socket.write(
              frame({
                'Content-Type': 'command/reply',
                'Reply-Text': ok ? '+OK accepted' : '-ERR',
              }),
            );
          } else if (line.startsWith('api ')) {
            const command = line.slice('api '.length);
            this.commands.push(command);
            socket.write(frame({ 'Content-Type': 'api/response' }, `${this.reply(command)}\n`));
          } else if (line === 'exit') {
            socket.end();
          }
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.listening = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
