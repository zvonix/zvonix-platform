import { describe, expect, it } from 'vitest';
import { BOT_SHARE_CALL, BOT_START_DEFAULT, botStartParts, botStartText } from './messaging.js';

describe('ответ бота при запуске', () => {
  it('своего текста нет — стандартный, с названием службы и призывом поделиться номером', () => {
    expect(botStartText(null, 'Такси Волна')).toBe(
      `${BOT_START_DEFAULT.replaceAll('{название}', 'Такси Волна')}\n\n${BOT_SHARE_CALL}`,
    );
    expect(botStartText(null, 'Такси Волна')).toContain('«Такси Волна»');
  });

  it('{название} и прежнее {служба} заменяются одинаково; призыв добавляется к своему тексту', () => {
    expect(botStartParts('Добро пожаловать в {название}!', 'Волна')).toEqual({
      text: 'Добро пожаловать в Волна!',
      call: BOT_SHARE_CALL,
    });
    expect(botStartParts('Вас приветствует {служба}', 'Волна').text).toBe('Вас приветствует Волна');
    expect(botStartText('Привет!', 'Волна')).toBe(`Привет!\n\n${BOT_SHARE_CALL}`);
  });

  it('текст сам называет кнопку — призыв не повторяется; прежняя надпись тоже считается', () => {
    expect(botStartText('Нажмите «ПОЛУЧАТЬ УВЕДОМЛЕНИЯ», {название}', 'Волна')).toBe(
      'Нажмите «ПОЛУЧАТЬ УВЕДОМЛЕНИЯ», Волна',
    );
    expect(botStartText('Нажмите «Поделиться номером»', 'Волна')).toBe(
      'Нажмите «Поделиться номером»',
    );
    // Своя надпись кнопки площадки: призыв не нужен, если текст её называет.
    expect(botStartParts('Жмите «Подписаться»', 'Волна', '✅ Подписаться').call).toBeNull();
    expect(botStartParts('Жмите «Подписаться»', 'Волна').call).toBe(BOT_SHARE_CALL);
  });

  it('несколько вхождений заменяются все', () => {
    expect(botStartParts('{название}, {название}', 'Я').text).toBe('Я, Я');
  });
});
