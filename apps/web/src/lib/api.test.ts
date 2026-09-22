import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './api';

/** Отмена, как её видит `fetch`: причина сигнала или стандартный `AbortError`. */
function abortReason(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('Запрос отменён', 'AbortError');
}

/** Прокси, который принял соединение и молчит, пока запрос не отменят. */
function silentServer() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(abortReason(init.signal));
          },
          { once: true },
        );
      }),
  );
}

/** Заголовки пришли, а тело застряло: браузер обрывает его, когда запрос отменяют. */
function stalledBody() {
  return vi.fn((_url: string, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        init?.signal?.addEventListener(
          'abort',
          () => {
            stream.error(abortReason(init.signal));
          },
          { once: true },
        );
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  });
}

/** Следит за обещанием, не дожидаясь его: проверка должна видеть, что оно ещё не решилось. */
function watch(promise: Promise<unknown>) {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

describe('запрос к API: предел ожидания', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('чтение ждёт 20 с и называет тайм-аут, а не молчит до закрытия вкладки', async () => {
    vi.stubGlobal('fetch', silentServer());
    const state = watch(request('/partners'));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.error).toBeInstanceOf(ApiError);
    const error = state.error as ApiError;
    expect(error.timedOut).toBe(true);
    expect(error.code).toBe('dependency_unavailable');
    expect(error.status).toBe(0);
    expect(error.details).toEqual({ timeout_ms: 20_000 });
    expect(error.message).toBe('Платформа не ответила за 20 с — повторите позже');
  });

  it('изменение без ответа называется «могло выполниться»: повтор вслепую опасен', async () => {
    vi.stubGlobal('fetch', silentServer());
    const state = watch(request('/partners', { method: 'POST', body: { name: 'x' } }));

    await vi.advanceTimersByTimeAsync(20_000);
    expect((state.error as ApiError).message).toBe(
      'Платформа не ответила за 20 с. Действие могло выполниться — проверьте результат, прежде чем повторять',
    );
  });

  it('свой предел у запроса, которому нужно дольше', async () => {
    vi.stubGlobal('fetch', silentServer());
    const state = watch(request('/settings/mail/test', { method: 'POST', timeoutMs: 40_000 }));

    await vi.advanceTimersByTimeAsync(39_999);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect((state.error as ApiError).details).toEqual({ timeout_ms: 40_000 });
    expect((state.error as ApiError).message).toMatch(/^Платформа не ответила за 40 с\./u);
  });

  it('тело, застрявшее после заголовков, — тоже тайм-аут, а не успех без тела', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const state = watch(request('/partners'));

    await vi.advanceTimersByTimeAsync(20_000);
    expect((state.error as ApiError).timedOut).toBe(true);
  });

  it('отмена вызывающим пробрасывается как отмена и не оставляет таймера', async () => {
    vi.stubGlobal('fetch', silentServer());
    const controller = new AbortController();
    const state = watch(request('/partners', { signal: controller.signal }));

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(state.error).toBeInstanceOf(DOMException);
    expect((state.error as DOMException).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отмена посреди тела — тоже отмена, а не успех без тела', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const controller = new AbortController();
    const state = watch(request('/partners', { signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect((state.error as DOMException).name).toBe('AbortError');
  });

  it('заранее отменённый запрос не уходит вовсе', async () => {
    const fetch = silentServer();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();

    await expect(request('/partners', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ответ снимает таймер и слушателя отмены', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ partners: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(request('/partners', { signal: controller.signal })).resolves.toEqual({
      partners: [],
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('обрыв сети — «не отвечает», и это не тайм-аут', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = await request('/partners').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Платформа не отвечает');
    expect((error as ApiError).timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
