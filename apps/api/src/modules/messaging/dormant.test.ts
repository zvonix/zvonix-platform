import { describe, expect, it } from 'vitest';
import { dormantStep } from './dormant.js';

const STEPS = [10, 20, 30] as const;

describe('dormantStep', () => {
  it('порог 0 — не проверять, какой бы длинной ни была серия', () => {
    expect(dormantStep(100, 0, STEPS)).toBeUndefined();
  });

  it('серия короче порога — пишем', () => {
    expect(dormantStep(0, 5, STEPS)).toBeUndefined();
    expect(dormantStep(4, 5, STEPS)).toBeUndefined();
  });

  it('ступени нарастают 10 → 20 → 30 и дальше держатся на 30', () => {
    expect(dormantStep(5, 5, STEPS)).toEqual({ position: 5, days: 10 });
    expect(dormantStep(9, 5, STEPS)).toEqual({ position: 5, days: 10 });
    expect(dormantStep(10, 5, STEPS)).toEqual({ position: 10, days: 20 });
    expect(dormantStep(15, 5, STEPS)).toEqual({ position: 15, days: 30 });
    expect(dormantStep(42, 5, STEPS)).toEqual({ position: 40, days: 30 });
  });
});
