import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { onSessionLost } from './session-lost';

const unauthenticated = new ApiError('unauthenticated', 'Требуется вход', 401, {}, undefined);

describe('сессия кончилась посреди работы', () => {
  it('отказ «требуется вход» от любого запроса перечитывает сессию', () => {
    const invalidateQueries = vi.fn();
    onSessionLost({ invalidateQueries }, unauthenticated, ['partner', 'equipment']);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['auth', 'me'] });
  });

  it('отказ самого запроса сессии не зацикливает перечитывание', () => {
    const invalidateQueries = vi.fn();
    onSessionLost({ invalidateQueries }, unauthenticated, ['auth', 'me']);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('другие ошибки сессию не трогают', () => {
    const invalidateQueries = vi.fn();
    onSessionLost(
      { invalidateQueries },
      new ApiError('permission_denied', 'Нет прав', 403, {}, undefined),
      ['x'],
    );
    onSessionLost({ invalidateQueries }, new Error('сеть'), ['x']);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
