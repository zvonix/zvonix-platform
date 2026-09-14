import { afterEach, describe, expect, it, vi } from 'vitest';
import { atMost } from './wait';

describe('ожидание не дольше предела', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('отпускает сразу, когда работа закончилась раньше предела', async () => {
    await expect(atMost(Promise.resolve('обновлено'), 1500)).resolves.toBeUndefined();
  });

  it('отпускает по пределу, если работа зависла: окно не висит до конца', async () => {
    vi.useFakeTimers();
    let released = false;
    const waiting = atMost(new Promise(() => undefined), 1500).then(() => {
      released = true;
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(released).toBe(true);
  });
});
