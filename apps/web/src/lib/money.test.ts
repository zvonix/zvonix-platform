import { describe, expect, it } from 'vitest';
import {
  basisPointsFromPercent,
  integerFromInput,
  isNegative,
  money,
  microunits,
  moneyFromInput,
  numberFromInput,
  percent,
} from './money.js';

/**
 * Пробелы в ожиданиях — escape-последовательностями, теми же, что в самом коде.
 * Неразрывный пробел неотличим от обычного глазами, и проверка, написанная обычным,
 * падает с сообщением «"42 ₽" не равно "42 ₽"».
 */
const N = '\u202F';
const B = '\u00A0';

describe('денежная сумма из поля ввода', () => {
  it('приводит к машинному виду то, что кабинет показывает', () => {
    expect(moneyFromInput('1 500,50')).toBe('1500.50');
    expect(moneyFromInput(`1${N}500${B}₽`)).toBe('1500');
    expect(moneyFromInput('0')).toBe('0');
    expect(moneyFromInput('0,000001')).toBe('0.000001');
  });

  it('отвергает то, что деньгами не является', () => {
    expect(moneyFromInput('')).toBeUndefined();
    expect(moneyFromInput('-5')).toBeUndefined();
    expect(moneyFromInput('1e3')).toBeUndefined();
    expect(moneyFromInput('двести')).toBeUndefined();
  });

  it('больше шести знаков после запятой — отказ: деньги площадки в микроединицах', () => {
    expect(moneyFromInput('1,1234567')).toBeUndefined();
  });

  it('знак процента в денежном поле — отказ, а не рубли', () => {
    expect(moneyFromInput('15%')).toBeUndefined();
  });
});

describe('сумма в микроединицах', () => {
  it('сравнивает границы точно, без плавающей точки', () => {
    expect(microunits('0.5')).toBe(BigInt(500_000));
    expect(microunits('3')).toBe(BigInt(3_000_000));
    expect(microunits('0.000001')).toBe(BigInt(1));
    expect(microunits('0.1') + microunits('0.2')).toBe(microunits('0.3'));
  });
});

describe('целое число из поля ввода', () => {
  it('принимает разряды через любой пробел — так кабинет их и показывает', () => {
    expect(integerFromInput('1000')).toBe(1000);
    expect(integerFromInput('1 000')).toBe(1000);
    expect(integerFromInput(`1${B}000`)).toBe(1000);
    expect(integerFromInput(`1${N}000`)).toBe(1000);
    expect(integerFromInput('1 000')).toBe(1000);
    expect(integerFromInput(' 42 ')).toBe(42);
  });

  it('не читает половину введённого, как parseInt', () => {
    // `Number.parseInt('1 000')` — 1: так лимит в тысячу вызовов сохранялся лимитом в один.
    expect(integerFromInput('1,5')).toBeUndefined();
    expect(integerFromInput('12abc')).toBeUndefined();
    expect(integerFromInput('1e3')).toBeUndefined();
  });

  it('пустое и отрицательное — не количество', () => {
    expect(integerFromInput('')).toBeUndefined();
    expect(integerFromInput('   ')).toBeUndefined();
    expect(integerFromInput('-1')).toBeUndefined();
  });

  it('ведущие нули не мешают, а число больше безопасного отвергается', () => {
    expect(integerFromInput('007')).toBe(7);
    expect(integerFromInput('9007199254740993')).toBeUndefined();
  });
});

describe('проценты из поля ввода', () => {
  it('переводит в сотые доли процента', () => {
    expect(basisPointsFromPercent('15')).toBe(1500);
    expect(basisPointsFromPercent('100')).toBe(10_000);
    expect(basisPointsFromPercent('0')).toBe(0);
  });

  it('принимает запятую, точку и знак процента', () => {
    expect(basisPointsFromPercent('0,28')).toBe(28);
    expect(basisPointsFromPercent('12.5')).toBe(1250);
    expect(basisPointsFromPercent('15 %')).toBe(1500);
    expect(basisPointsFromPercent(`15${B}%`)).toBe(1500);
  });

  it('считает без плавающей точки', () => {
    // `Math.round(0.285 * 100)` даёт 28, а не 29: процент числом с плавающей точкой
    // считать нельзя, поэтому разбор строковый.
    expect(basisPointsFromPercent('0,29')).toBe(29);
    expect(basisPointsFromPercent('1,01')).toBe(101);
  });

  it('лишний знак после запятой — отказ, а не молчаливое округление', () => {
    expect(basisPointsFromPercent('0,285')).toBeUndefined();
    expect(basisPointsFromPercent('15,2549')).toBeUndefined();
  });

  it('пустое поле — отказ: раньше оно становилось наценкой 0 %', () => {
    expect(basisPointsFromPercent('')).toBeUndefined();
    expect(basisPointsFromPercent('%')).toBeUndefined();
    expect(basisPointsFromPercent('-5')).toBeUndefined();
    expect(basisPointsFromPercent('1e1')).toBeUndefined();
  });
});

describe('показ денег', () => {
  it('добавляет валюту явно', () => {
    expect(money('1500')).toBe(`1${N}500${B}₽`);
  });

  it('разделяет разряды', () => {
    expect(money('1234567')).toBe(`1${N}234${N}567${B}₽`);
    expect(money('999')).toBe(`999${B}₽`);
    expect(money('1000')).toBe(`1${N}000${B}₽`);
  });

  it('дробная часть видна и не округляется', () => {
    // DESIGN.md: деньги никогда не округляются в отображении молча.
    expect(money('1500.5')).toBe(`1${N}500,5${B}₽`);
    expect(money('0.000001')).toBe(`0,000001${B}₽`);
    expect(money('12.34')).toBe(`12,34${B}₽`);
  });

  it('запятая как разделитель дробной части — русское написание', () => {
    expect(money('1234.56')).toBe(`1${N}234,56${B}₽`);
  });

  it('отрицательная сумма сохраняет знак', () => {
    expect(money('-250.75')).toBe(`-250,75${B}₽`);
    expect(money('-1234567.1')).toBe(`-1${N}234${N}567,1${B}₽`);
  });

  it('ноль остаётся нулём, а не пустотой', () => {
    expect(money('0')).toBe(`0${B}₽`);
  });

  it('не сумма показывается как есть', () => {
    // Молча подставить ноль было бы хуже: на экране денег неверное число
    // опаснее непонятного.
    expect(money('нет данных')).toBe('нет данных');
    expect(money('')).toBe('');
    expect(money('1.2.3')).toBe('1.2.3');
  });

  it('пробелы по краям не мешают', () => {
    expect(money('  42  ')).toBe(`42${B}₽`);
  });
});

describe('знак суммы', () => {
  it('минус распознаётся', () => {
    expect(isNegative('-1')).toBe(true);
    expect(isNegative('  -0.5')).toBe(true);
  });

  it('ноль и положительное — не долг', () => {
    expect(isNegative('0')).toBe(false);
    expect(isNegative('1500.5')).toBe(false);
  });
});

describe('доля в процентах', () => {
  it('базисные пункты показываются процентом', () => {
    // API отдаёт десятитысячные, договорённость звучит «пятнадцать процентов».
    expect(percent('1500')).toBe(`15${B}%`);
    expect(percent('0')).toBe(`0${B}%`);
    expect(percent('10000')).toBe(`100${B}%`);
  });

  it('дробная доля не теряется', () => {
    expect(percent('1525')).toBe(`15,25${B}%`);
    expect(percent('1')).toBe(`0,01${B}%`);
  });

  it('не число показывается как есть', () => {
    expect(percent('нет данных')).toBe('нет данных');
  });
});

describe('разбор набранного человеком', () => {
  it('принимает запятую: с ней сумма и показывается, и набирается на русской раскладке', () => {
    expect(numberFromInput('0,1')).toBe('0.1');
    expect(numberFromInput('1500,5')).toBe('1500.5');
  });

  it('точку не портит: кто набрал по-машинному, тоже прав', () => {
    expect(numberFromInput('0.1')).toBe('0.1');
    expect(numberFromInput('12')).toBe('12');
  });

  it('переживает вставку из соседней таблицы', () => {
    // Ровно то, что выводит `money`: неразрывные пробелы разрядов и знак валюты.
    expect(numberFromInput(money('1500.5'))).toBe('1500.5');
    expect(numberFromInput(percent('1525'))).toBe('15.25');
  });

  it('не превращает мусор в число', () => {
    // Отказ — дело API: молча подставленный ноль на экране денег хуже отказа.
    expect(numberFromInput('нет')).toBe('нет');
  });
});
