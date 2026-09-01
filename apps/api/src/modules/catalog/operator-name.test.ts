import { describe, expect, it } from 'vitest';
import { normalizeOperatorName } from './operator-name.js';

describe('приведение названия оператора', () => {
  it.each([
    ['ООО "Сбербанк-Телеком"', 'сбербанк-телеком'],
    ['Сбербанк-Телеком', 'сбербанк-телеком'],
    ['ООО «Сбербанк-Телеком»', 'сбербанк-телеком'],
    ['  ПАО  МегаФон  ', 'мегафон'],
    ['ОАО «Вымпел-Коммуникации»', 'вымпел-коммуникации'],
    ['Т2 Мобайл', 'т2 мобайл'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOperatorName(input)).toBe(expected);
  });

  it('разные написания одного оператора совпадают', () => {
    // Ради этого свойства и существует приведение: иначе файл плана нумерации
    // и сервис определения дадут двух разных операторов.
    const forms = ['ООО "Сбербанк-Телеком"', 'Сбербанк-Телеком', 'ООО «СБЕРБАНК-ТЕЛЕКОМ»'];
    expect(new Set(forms.map(normalizeOperatorName)).size).toBe(1);
  });

  it('снимает различие ё и е', () => {
    // В выгрузках пишут и так и так, и это единственное различие даёт два оператора.
    expect(normalizeOperatorName('МегаФон')).toBe(normalizeOperatorName('МегаФон'));
    expect(normalizeOperatorName('Т-Мобайл ё')).toBe(normalizeOperatorName('Т-Мобайл е'));
  });

  it('не склеивает разных операторов', () => {
    // Приведение обязано убирать шум, а не смысл.
    expect(normalizeOperatorName('МТС')).not.toBe(normalizeOperatorName('МегаФон'));
    expect(normalizeOperatorName('Т2 Мобайл')).not.toBe(normalizeOperatorName('Т-Мобайл'));
  });

  it('не оставляет организационную форму внутри названия', () => {
    expect(normalizeOperatorName('АО "ЭР-Телеком Холдинг"')).toBe('эр-телеком холдинг');
  });

  it('устойчив к пустой строке и мусору', () => {
    expect(normalizeOperatorName('')).toBe('');
    expect(normalizeOperatorName('   ')).toBe('');
    expect(normalizeOperatorName('«»')).toBe('');
  });
});
