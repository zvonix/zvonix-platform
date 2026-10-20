import { describe, expect, it } from 'vitest';
import { composeMessage, type TemplateBlock } from './message-template.js';

const body: TemplateBlock = { kind: 'body', when: 'always' };
const ctx = {
  body: 'Ваша машина прибыла',
  name: 'Иван',
  company: 'Салон Лотос',
  botLink: 'https://max.ru/b?start=x',
  first: true,
  route: 'account' as const,
};

describe('сборка сообщения из шаблона', () => {
  it('без шаблона уходит текст клиента как есть', () => {
    expect(composeMessage([body], ctx)).toBe('Ваша машина прибыла');
  });

  it('приветствие с именем, текст, ссылка на бота — в заданном порядке', () => {
    const blocks: TemplateBlock[] = [
      { kind: 'greeting', text: 'Здравствуйте, {имя}!', when: 'always' },
      body,
      { kind: 'text', text: 'Такси Волна', when: 'always' },
      { kind: 'bot_link', when: 'always' },
    ];
    expect(composeMessage(blocks, ctx)).toBe(
      'Здравствуйте, Иван!\nВаша машина прибыла\nТакси Волна\nhttps://max.ru/b?start=x',
    );
  });

  it('имени нет — приветствие без него и без лишней запятой', () => {
    const greeting: TemplateBlock = {
      kind: 'greeting',
      text: 'Здравствуйте, {имя}!',
      when: 'always',
    };
    expect(composeMessage([greeting, body], { ...ctx, name: null })).toBe(
      'Здравствуйте!\nВаша машина прибыла',
    );
    const other: TemplateBlock = { kind: 'greeting', text: '{имя}, добрый день', when: 'always' };
    expect(composeMessage([other, body], { ...ctx, name: null })).toBe(
      'добрый день\nВаша машина прибыла',
    );
  });

  it('«только первое»: в повторных сообщениях блока нет; тело — всегда', () => {
    const blocks: TemplateBlock[] = [
      { kind: 'text', text: 'Мы теперь и в MAX', when: 'first' },
      body,
    ];
    expect(composeMessage(blocks, ctx)).toBe('Мы теперь и в MAX\nВаша машина прибыла');
    expect(composeMessage(blocks, { ...ctx, first: false })).toBe('Ваша машина прибыла');
  });

  it('бота нет — ссылка пропускается, пустой блок не оставляет пустой строки', () => {
    const blocks: TemplateBlock[] = [body, { kind: 'bot_link', when: 'always' }];
    expect(composeMessage(blocks, { ...ctx, botLink: null })).toBe('Ваша машина прибыла');
  });

  it('не влезло в предел — один текст клиента, без вставок', () => {
    const long = 'я'.repeat(3990);
    const blocks: TemplateBlock[] = [body, { kind: 'text', text: 'ы'.repeat(100), when: 'always' }];
    expect(composeMessage(blocks, { ...ctx, body: long })).toBe(long);
  });

  it('«где»: блок только для бота не попадает в сообщение через аккаунты, и наоборот; без «где» — везде', () => {
    const blocks: TemplateBlock[] = [
      body,
      { kind: 'text', text: 'для бота', when: 'always', via: 'bot' },
      { kind: 'bot_link', when: 'always', via: 'account' },
      { kind: 'text', text: 'везде', when: 'always' },
    ];
    expect(composeMessage(blocks, ctx)).toBe(
      'Ваша машина прибыла\nhttps://max.ru/b?start=x\nвезде',
    );
    expect(composeMessage(blocks, { ...ctx, route: 'bot' })).toBe(
      'Ваша машина прибыла\nдля бота\nвезде',
    );
  });

  it('«Пустая строка» отделяет части; не в начале, не подряд и не в конце', () => {
    const brk: TemplateBlock = { kind: 'break', when: 'always' };
    const text: TemplateBlock = { kind: 'text', text: 'Салон', when: 'always' };
    expect(composeMessage([brk, body, brk, brk, text, brk], ctx)).toBe(
      'Ваша машина прибыла\n\nСалон',
    );
  });

  it('{название} подставляется в приветствие и в свой текст; многострочный текст сохраняется', () => {
    const blocks: TemplateBlock[] = [
      { kind: 'greeting', text: 'Добро пожаловать в {название}, {имя}!', when: 'always' },
      body,
      { kind: 'text', text: 'Адрес: ул. Мира, 1\nТел. 000', when: 'always' },
    ];
    expect(composeMessage(blocks, ctx)).toBe(
      'Добро пожаловать в Салон Лотос, Иван!\nВаша машина прибыла\nАдрес: ул. Мира, 1\nТел. 000',
    );
  });
});
