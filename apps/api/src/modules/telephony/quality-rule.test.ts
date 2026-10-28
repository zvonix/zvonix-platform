import { describe, expect, it } from 'vitest';
import { connectsPoorly, failsOnNetwork, type QualityView } from './quality.service.js';

const row = (overrides: Partial<QualityView>): QualityView =>
  ({
    subjectId: 's1',
    subjectName: '79161000001',
    subjectStatus: 'active',
    partnerId: 'pt1',
    partnerName: 'Партнёр',
    attempts: 20,
    answered: 2,
    networkFailures: 9,
    talkSeconds: 60,
    asrBasisPoints: 1000,
    acdSeconds: 30,
    ...overrides,
  }) as QualityView;

describe('«почти не соединяет» (ADR-0062, ADR-0103)', () => {
  it('работает, вызовов не меньше 10, состоялось меньше 30 %', () => {
    expect(connectsPoorly(row({}))).toBe(true);
    expect(connectsPoorly(row({ attempts: 9 }))).toBe(false);
    expect(connectsPoorly(row({ asrBasisPoints: 3000 }))).toBe(false);
    expect(connectsPoorly(row({ subjectStatus: 'throttled' }))).toBe(false);
  });

  it('по вине сети — когда отказов сети не меньше половины несостоявшихся', () => {
    // Несостоявшихся 18: девять отказов сети — ровно половина.
    expect(failsOnNetwork(row({ networkFailures: 9 }))).toBe(true);
    // Восемь — меньше половины: остальное «не ответил» и «занято», это база клиента.
    expect(failsOnNetwork(row({ networkFailures: 8 }))).toBe(false);
    // Мало вызовов — не тревога вовсе, сколько бы ни было отказов.
    expect(failsOnNetwork(row({ attempts: 5, answered: 0, networkFailures: 5 }))).toBe(false);
  });
});
