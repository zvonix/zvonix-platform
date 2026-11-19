import { describe, expect, it } from 'vitest';
import { LIVE_BY_DEFAULT, LIVE_OPTIONS, liveSecondsFrom } from './live.js';

describe('как часто страница обновляется сама', () => {
  it('пока выбора нет — значение страницы', () => {
    expect(liveSecondsFrom(null, LIVE_BY_DEFAULT)).toBe(10);
    expect(liveSecondsFrom(null, 0)).toBe(0);
    expect(liveSecondsFrom('', LIVE_BY_DEFAULT)).toBe(10);
  });

  it('сделанный выбор действует на всех страницах, «выкл» тоже', () => {
    expect(liveSecondsFrom('0', LIVE_BY_DEFAULT)).toBe(0);
    expect(liveSecondsFrom('5', LIVE_BY_DEFAULT)).toBe(5);
    expect(liveSecondsFrom('15', 0)).toBe(15);
  });

  it('непонятный или устаревший выбор — значение страницы, а не «выкл»', () => {
    expect(liveSecondsFrom('30', LIVE_BY_DEFAULT)).toBe(10);
    expect(liveSecondsFrom('abc', LIVE_BY_DEFAULT)).toBe(10);
    expect(liveSecondsFrom('abc', 0)).toBe(0);
  });

  it('значение по умолчанию есть среди вариантов переключателя', () => {
    expect(LIVE_OPTIONS.map((option) => option.seconds)).toContain(LIVE_BY_DEFAULT);
  });
});
