import { describe, expect, it } from 'vitest';
import { changeDirection, changeText, periodChange, PERCENT_LIMIT } from './period-change.js';

describe('изменение к прошлому периоду', () => {
  it('обычный рост и падение — процентом', () => {
    expect(changeText(periodChange(150, 100))).toBe('+50,0 % к прошлому периоду');
    expect(changeText(periodChange(50, 100))).toBe('-50,0 % к прошлому периоду');
    expect(changeText(periodChange(0, 100))).toBe('-100,0 % к прошлому периоду');
  });

  it('раньше был ноль — словами, без деления на ноль', () => {
    expect(periodChange(5, 0)).toEqual({ kind: 'new' });
    expect(changeText(periodChange(5, 0))).toBe('раньше не было');
    expect(changeText(periodChange(0, 0))).toBe('без изменений');
  });

  it('раньше почти ноль — словами, а не «+972 400 %»', () => {
    // Случай владельца: несколько копеек в прошлом периоде и сотни рублей в нынешнем.
    expect(changeText(periodChange(97.25, 0.01))).toBe('раньше почти не было');
    expect(changeDirection(periodChange(97.25, 0.01))).toBe('up');
  });

  it('порог: ровно тысяча процентов ещё числом, больше — словами', () => {
    expect(PERCENT_LIMIT).toBe(1000);
    expect(changeText(periodChange(11, 1))).toBe('+1000,0 % к прошлому периоду');
    expect(changeText(periodChange(11.5, 1))).toBe('раньше почти не было');
  });

  it('отрицательное прошлое: рост остаётся ростом', () => {
    expect(changeText(periodChange(10, -10))).toBe('+200,0 % к прошлому периоду');
    expect(changeText(periodChange(-100, -0.01))).toBe('намного меньше, чем раньше');
    expect(changeDirection(periodChange(-100, -0.01))).toBe('down');
  });

  it('доля — в процентных пунктах', () => {
    expect(changeText({ kind: 'percent', value: 2.5 }, true)).toBe('+2,5 п. п. к прошлому периоду');
    expect(changeText({ kind: 'unknown' })).toBe('нет данных для сравнения');
  });

  it('крошечное изменение — «без изменений»', () => {
    expect(changeDirection(periodChange(100.01, 100))).toBe('flat');
    expect(changeText(periodChange(100.01, 100))).toBe('без изменений');
    expect(periodChange(Number.NaN, 1)).toEqual({ kind: 'unknown' });
  });
});
