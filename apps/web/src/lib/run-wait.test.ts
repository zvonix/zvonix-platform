import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { waitForRun, type RunLog } from './run-wait';

const apiError = (status: number, message = 'ошибка'): ApiError =>
  new ApiError(status === 404 ? 'not_found' : 'internal', message, status, {}, undefined);

const running: RunLog = { text: '', run: { status: 'running' } };
const succeeded: RunLog = { text: 'копия годна', run: { status: 'succeeded' } };

/** Журнал, который отвечает по сценарию: значение — ответ, ошибка — отказ. */
function script(steps: (RunLog | Error)[]) {
  let index = 0;
  const waits: number[] = [];
  return {
    waits,
    calls: () => index,
    options: {
      fetchLog: () => {
        const step = steps[Math.min(index, steps.length - 1)];
        index += 1;
        return step instanceof Error ? Promise.reject(step) : Promise.resolve(step as RunLog);
      },
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe('ожидание заявки к службе', () => {
  it('«Такого обновления нет» сразу после заявки — это ожидание, а не ошибка', async () => {
    // Именно так это и было на сервере: 404, пока служба не приняла заявку; потом «идёт»; потом «готово».
    const log = script([apiError(404, 'Такого обновления нет'), apiError(404), running, succeeded]);
    await expect(waitForRun('id', 'Проверка', log.options)).resolves.toBeUndefined();
    expect(log.calls()).toBe(4);
    expect(log.waits).toHaveLength(3);
  });

  it('служба или кабинет перезапускаются (5xx, обрыв связи) — ждём и доводим до конца', async () => {
    const log = script([apiError(502), new TypeError('Failed to fetch'), succeeded]);
    await expect(waitForRun('id', 'Проверка', log.options)).resolves.toBeUndefined();
  });

  it('провал заявки — ошибка с последней строкой журнала; повторных опросов нет', async () => {
    const log = script([{ text: 'идёт\nкопия не разворачивается', run: { status: 'failed' } }]);
    await expect(waitForRun('id', 'Проверка', log.options)).rejects.toThrow(
      'Проверка не удалось: копия не разворачивается',
    );
    expect(log.calls()).toBe(1);
  });

  it('настоящий отказ (нет прав, плохой запрос) не пережидается', async () => {
    const log = script([apiError(403, 'Нет доступа')]);
    await expect(waitForRun('id', 'Проверка', log.options)).rejects.toThrow('Нет доступа');
    expect(log.calls()).toBe(1);
  });

  it('заявку так и не приняли — через время понятная причина, а не вечное ожидание', async () => {
    let time = 0;
    const log = script([apiError(404)]);
    await expect(
      waitForRun('id', 'Проверка', {
        ...log.options,
        now: () => (time += 60_000),
        timeoutMs: 5 * 60_000,
      }),
    ).rejects.toThrow('служба не приняла заявку');
  });

  it('заявку приняли, но она не кончается — «слишком долго», а не «не приняла»', async () => {
    let time = 0;
    const log = script([running]);
    await expect(
      waitForRun('id', 'Проверка', {
        ...log.options,
        now: () => (time += 60_000),
        timeoutMs: 5 * 60_000,
      }),
    ).rejects.toThrow('слишком долго не отвечает');
  });
});
