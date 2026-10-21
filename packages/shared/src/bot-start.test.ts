import { describe, expect, it } from 'vitest';
import { BOT_START_DEFAULT, botStartText } from './messaging.js';

describe('ответ бота при запуске', () => {
  it('своего текста нет — стандартный, с названием службы', () => {
    expect(botStartText(null, 'Такси Волна')).toBe(
      BOT_START_DEFAULT.replaceAll('{название}', 'Такси Волна'),
    );
    expect(botStartText(null, 'Такси Волна')).toContain('«Такси Волна»');
  });

  it('{название} и прежнее {служба} заменяются одинаково; текст без переменных остаётся как есть', () => {
    expect(botStartText('Добро пожаловать в {название}!', 'Волна')).toBe(
      'Добро пожаловать в Волна!',
    );
    expect(botStartText('Вас приветствует {служба}', 'Волна')).toBe('Вас приветствует Волна');
    expect(botStartText('Привет!', 'Волна')).toBe('Привет!');
  });

  it('несколько вхождений заменяются все', () => {
    expect(botStartText('{название}, {название}', 'Я')).toBe('Я, Я');
  });
});
