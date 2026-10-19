import { ApiError, request } from './api';

/**
 * Ожидание заявки к службе обновления (копии, проверка, выдача).
 *
 * Кабинет ставит заявку и спрашивает её журнал, но служба принимает её не мгновенно: пока не приняла, журнала нет, и API
 * отвечает «Такого обновления нет» (`404`). Раньше страница считала это провалом и показывала ошибку, хотя заявка
 * спокойно выполнялась (замечено владельцем на живом сервере, 2026-10-19). Теперь `404` — «ещё не принята», а `5xx` и
 * обрыв связи — «служба или кабинет перезапускаются»: и то и другое ожидание, а не отказ.
 */

interface Run {
  readonly status: 'running' | 'succeeded' | 'failed';
}

export interface RunLog {
  readonly text: string;
  readonly run: Run;
}

interface Options {
  /** Журнал заявки. В проверках подменяется. */
  readonly fetchLog?: (id: string) => Promise<RunLog>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Сколько ждать всего; по умолчанию четверть часа — дольше проверка или выдача копии не идёт. */
  readonly timeoutMs?: number;
}

/** Отличает провал самой заявки от ожидаемых сбоев опроса: его не пережидают. */
class Failed extends Error {}

const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

const defaultFetch = (id: string): Promise<RunLog> =>
  request<RunLog>(`/updates/${id}/log?offset=0`);
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Ждёт исхода заявки; провал превращается в ошибку с последней строкой журнала. */
export async function waitForRun(id: string, what: string, options: Options = {}): Promise<void> {
  const fetchLog = options.fetchLog ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let accepted = false;

  for (;;) {
    try {
      const log = await fetchLog(id);
      accepted = true;
      if (log.run.status === 'succeeded') return;
      if (log.run.status === 'failed') {
        const last = log.text.trim().split('\n').pop() ?? '';
        throw new Failed(`${what} не удалось${last === '' ? '' : `: ${last}`}`);
      }
    } catch (error) {
      if (error instanceof Failed) throw error;
      // Заявка ещё не принята (404) или связь на миг пропала (5xx, обрыв): ждём. Всё прочее — настоящий отказ.
      const waiting = !(error instanceof ApiError) || error.status === 404 || error.status >= 500;
      if (!waiting) throw error;
    }
    if (now() > deadline) {
      throw new Error(
        accepted
          ? `${what}: служба слишком долго не отвечает`
          : `${what}: служба не приняла заявку — проверьте, что служба обновления работает`,
      );
    }
    await sleep(POLL_MS);
  }
}
