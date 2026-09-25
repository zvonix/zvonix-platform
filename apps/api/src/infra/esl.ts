/**
 * Клиент ESL FreeSWITCH — соединение на одну команду
 * ([ADR-0046](../../../../docs/adr/0046-iniciaciya-vyzova-iz-api.md),
 * [ADR-0055](../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 *
 * Подключились, предъявили пароль, отдали `api <команда>`, прочли ответ, закрыли.
 * Долгоживущего соединения с подпиской на события здесь нет намеренно: оно нужно для
 * событий в реальном времени, и это отдельная работа.
 *
 * Свой, а не пакет: протокол — заголовки, пустая строка и тело по `Content-Length`,
 * а пакеты для Node либо заброшены, либо держат постоянное соединение.
 *
 * Сообщение ESL:
 *
 *   Content-Type: api/response
 *   Content-Length: 41
 *
 *   +OK 5f1c…
 */

import { Socket } from 'node:net';

export interface EslTarget {
  readonly host: string;
  readonly port: number;
  readonly password: string;
}

export type EslFailure = 'connect' | 'auth' | 'timeout' | 'protocol';

export class EslError extends Error {
  override readonly name = 'EslError';

  constructor(
    readonly failure: EslFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface EslMessage {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Потолок одного сообщения: ответ `api` — строка, а не выгрузка; больше — чужой сервер. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

const CONNECT_TIMEOUT_MS = 3_000;

/**
 * Выполняет `api <command>` и возвращает тело ответа как есть (`+OK …` или `-ERR …`).
 *
 * `timeoutMs` — на всё целиком, от подключения до ответа: `originate` держит ответ,
 * пока абонент не снимет трубку или не истечёт `originate_timeout`, поэтому срок здесь
 * задаёт вызывающий, а не клиент.
 */
export async function eslApi(
  target: EslTarget,
  command: string,
  options: { readonly timeoutMs: number },
): Promise<string> {
  // Перевод строки в команде закончил бы её и начал следующую — с правами площадки.
  if (/[\r\n]/.test(command) || /[\r\n]/.test(target.password)) {
    throw new EslError('protocol', 'Команда ESL содержит перевод строки');
  }

  const socket = new Socket();
  const reader = new MessageReader(socket);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EslError('timeout', `ESL не ответил за ${String(options.timeoutMs)} мс`));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([deadline, converse(socket, reader, target, command)]);
  } finally {
    clearTimeout(timer);
    reader.close();
    socket.destroy();
  }
}

async function converse(
  socket: Socket,
  reader: MessageReader,
  target: EslTarget,
  command: string,
): Promise<string> {
  await connect(socket, target);

  const greeting = await reader.next();
  if (greeting.headers.get('content-type') !== 'auth/request') {
    throw new EslError('protocol', 'ESL не запросил пароль');
  }

  socket.write(`auth ${target.password}\n\n`);
  const auth = await reader.next();
  const reply = auth.headers.get('reply-text') ?? '';
  if (!reply.startsWith('+OK')) {
    throw new EslError('auth', 'ESL не принял пароль');
  }

  socket.write(`api ${command}\n\n`);
  // Между ответом на пароль и ответом на команду сервер может прислать служебное
  // сообщение (уведомление об отключении журнала и т. п.) — пропускаем всё, что не ответ.
  for (;;) {
    const message = await reader.next();
    if (message.headers.get('content-type') === 'api/response') {
      socket.write('exit\n\n');
      return message.body.trim();
    }
  }
}

function connect(socket: Socket, target: EslTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EslError('connect', `Нет соединения с ESL ${target.host}:${String(target.port)}`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (cause) => {
      clearTimeout(timer);
      reject(
        new EslError('connect', `Нет соединения с ESL ${target.host}:${String(target.port)}`, {
          cause,
        }),
      );
    });
    socket.connect(target.port, target.host);
  });
}

/**
 * Разбор потока на сообщения.
 *
 * Байты, а не строки: `Content-Length` считается в байтах, и тело с кириллицей,
 * порезанное по символам, съехало бы на следующий заголовок.
 */
class MessageReader {
  private buffer = Buffer.alloc(0);
  private readonly ready: EslMessage[] = [];
  private waiting: { resolve: (m: EslMessage) => void; reject: (e: Error) => void } | undefined;
  private failure: Error | undefined;

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : new EslError('protocol', String(cause)));
    }
  };

  private readonly onEnd = (): void => {
    this.fail(new EslError('protocol', 'ESL закрыл соединение раньше ответа'));
  };

  private readonly onError = (cause: Error): void => {
    this.fail(new EslError('protocol', 'Соединение ESL оборвалось', { cause }));
  };

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  next(): Promise<EslMessage> {
    const message = this.ready.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  close(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length > MAX_MESSAGE_BYTES) {
        throw new EslError('protocol', 'Сообщение ESL больше допустимого');
      }
      const end = this.buffer.indexOf('\n\n');
      if (end === -1) return;

      const headers = parseHeaders(this.buffer.subarray(0, end).toString('utf8'));
      const length = Number.parseInt(headers.get('content-length') ?? '0', 10);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        throw new EslError('protocol', 'Неверная длина сообщения ESL');
      }
      const bodyStart = end + 2;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.deliver({ headers, body });
    }
  }

  private deliver(message: EslMessage): void {
    const waiting = this.waiting;
    if (waiting === undefined) {
      this.ready.push(message);
      return;
    }
    this.waiting = undefined;
    waiting.resolve(message);
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
  }
}

/** Имена заголовков — в нижнем регистре: FreeSWITCH пишет их по-разному в разных версиях. */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), decodeValue(line.slice(colon + 1)));
  }
  return headers;
}

/** Значения заголовков ESL бывают percent-кодированы; битое кодирование оставляем как есть. */
function decodeValue(raw: string): string {
  const value = raw.trim();
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
