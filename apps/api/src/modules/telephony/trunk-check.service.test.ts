import { describe, expect, it } from 'vitest';
import { parseReply } from './trunk-check.service.js';

describe('ответ узла на проверку связи (ADR-0122)', () => {
  it('первая строка — итог без «ИТОГ:», остальное — подробности', () => {
    expect(parseReply('ИТОГ: провайдер отвечает\nПровайдер: a → b\nСостояние: REGED\n')).toEqual({
      summary: 'провайдер отвечает',
      details: 'Провайдер: a → b\nСостояние: REGED',
    });
  });

  it('старый узел команду не знает — просим подождать обновления', () => {
    expect(parseReply('-ERR NODE_REFUSED').summary).toMatch(/не обновился/u);
  });

  it('ответ без итога — показывается целиком в подробностях', () => {
    expect(parseReply('что-то странное')).toEqual({
      summary: 'Узел прислал непонятный ответ — подробности ниже',
      details: 'что-то странное',
    });
  });
});
