import { describe, expect, it } from 'vitest';
import { boundedLimit, boundedOffset } from './pagination.js';

describe('размер страницы', () => {
  it('без параметра — умолчание', () => {
    expect(boundedLimit(undefined)).toBe(100);
  });

  it('разумное значение проходит как есть', () => {
    expect(boundedLimit('25')).toBe(25);
  });

  it('запрос сверх потолка обрезается, а не отклоняется', () => {
    expect(boundedLimit('999999')).toBe(1000);
    expect(boundedLimit('999999', 200)).toBe(200);
  });

  it('свой потолок ниже умолчания опускает и умолчание', () => {
    // Иначе страница без параметра оказалась бы больше разрешённой этому обработчику.
    expect(boundedLimit(undefined, 20)).toBe(20);
  });

  it('мусор, ноль и отрицательное дают умолчание, а не отказ', () => {
    for (const raw of ['', 'не-число', '0', '-10', 'NaN']) {
      expect(boundedLimit(raw)).toBe(100);
    }
  });

  it('дробное усекается разбором целого', () => {
    expect(boundedLimit('12.9')).toBe(12);
  });
});

describe('смещение', () => {
  it('без параметра — начало списка', () => {
    expect(boundedOffset(undefined)).toBe(0);
  });

  it('разумное значение проходит как есть', () => {
    expect(boundedOffset('40')).toBe(40);
  });

  it('мусор и отрицательное — тоже начало списка', () => {
    for (const raw of ['', 'назад', '-1', '0']) {
      expect(boundedOffset(raw)).toBe(0);
    }
  });
});
