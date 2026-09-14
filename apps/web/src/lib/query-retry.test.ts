import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { shouldRetryQuery } from './query-retry';

function apiError(status: number, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(
    status === 0 ? 'dependency_unavailable' : 'internal',
    'x',
    status,
    details,
    undefined,
  );
}

describe('повтор запроса чтения', () => {
  it('сбой сервера повторяется дважды, третьего раза нет', () => {
    expect(shouldRetryQuery(0, apiError(500))).toBe(true);
    expect(shouldRetryQuery(1, apiError(500))).toBe(true);
    expect(shouldRetryQuery(2, apiError(500))).toBe(false);
  });

  it('отказ 4xx не повторяется: от повтора он не изменится', () => {
    expect(shouldRetryQuery(0, apiError(404))).toBe(false);
    expect(shouldRetryQuery(0, apiError(401))).toBe(false);
  });

  it('истёкшее ожидание не повторяется: экран говорит, что происходит, а не грузится минуту', () => {
    expect(shouldRetryQuery(0, apiError(0, { timeout_ms: 20_000 }))).toBe(false);
  });

  it('недоступность сети повторяется: она бывает мгновенной', () => {
    expect(shouldRetryQuery(0, apiError(0))).toBe(true);
  });
});
