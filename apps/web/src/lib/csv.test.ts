import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvCell, csvName, EXPORT_ROWS_MAX, loadAllCalls, toCsv } from './csv';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('csvCell', () => {
  it('пустое и отсутствующее — пустая ячейка', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('разделитель, кавычка и перенос строки берут ячейку в кавычки', () => {
    expect(csvCell('а;б')).toBe('"а;б"');
    expect(csvCell('«он сказал "да"»')).toBe('"«он сказал ""да""»"');
    expect(csvCell('две\nстроки')).toBe('"две\nстроки"');
  });

  it('формулу из имени, заданного человеком, обезвреживает апострофом', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('+cmd')).toBe("'+cmd");
  });

  it('номер и сумма со знаком остаются числами', () => {
    expect(csvCell('+79991234567')).toBe('+79991234567');
    expect(csvCell('-12,50')).toBe('-12,50');
    expect(csvCell(42)).toBe('42');
  });
});

describe('toCsv', () => {
  it('начинает файл меткой порядка байтов и режет строки CRLF', () => {
    expect(toCsv(['а', 'б'], [[1, 'в;г']])).toBe('﻿а;б\r\n1;"в;г"\r\n');
  });
});

describe('csvName', () => {
  it('добавляет дату по местным часам', () => {
    expect(csvName('вызовы', new Date(2026, 9, 1, 12))).toBe('вызовы-2026-10-01.csv');
  });
});

describe('loadAllCalls', () => {
  function stubPages(total: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn((input: string) => {
      const url = new URL(input, 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const calls = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => ({
          n: offset + i,
        }),
      );
      return Promise.resolve(
        new Response(JSON.stringify({ calls, total }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('собирает все страницы подряд', async () => {
    const fetchMock = stubPages(450);
    const found = await loadAllCalls<{ n: number }>(
      '/client/calls',
      new URLSearchParams('status=failed'),
    );
    expect(found.rows).toHaveLength(450);
    expect(found.rows[449]?.n).toBe(449);
    expect(found.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('status=failed');
  });

  it('останавливается на пределе и говорит об усечении', async () => {
    stubPages(EXPORT_ROWS_MAX + 500);
    const found = await loadAllCalls<{ n: number }>('/calls', new URLSearchParams());
    expect(found.rows).toHaveLength(EXPORT_ROWS_MAX);
    expect(found.truncated).toBe(true);
  });
});
