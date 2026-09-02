/**
 * Разбор CDR от FreeSWITCH.
 *
 * Числа приходят строками, отметки времени — без пояса, а «события не было» выглядит
 * как `0000-00-00`. Каждая из этих особенностей при наивном разборе даёт не ошибку,
 * а неверную сумму или 1970 год в отчёте.
 */

import { describe, expect, it } from 'vitest';
import { CdrParseError, parseCdr, statusFromHangupCause } from './cdr-parse.js';

function cdr(variables: Record<string, unknown>) {
  return { variables: { uuid: 'a1b2c3', ...variables } };
}

describe('разбор тела', () => {
  it('достаёт то, без чего нельзя тарифицировать', () => {
    const parsed = parseCdr(
      cdr({
        billsec: '137',
        hangup_cause: 'NORMAL_CLEARING',
        answer_stamp: '2026-09-02 07:15:42.123456',
        end_stamp: '2026-09-02 07:17:59.000000',
        zvonix_call_id: '0198f3c4',
      }),
    );

    expect(parsed.uuid).toBe('a1b2c3');
    expect(parsed.billableSeconds).toBe(137);
    expect(parsed.hangupCause).toBe('NORMAL_CLEARING');
    expect(parsed.zvonixCallId).toBe('0198f3c4');
    expect(parsed.answeredAt?.toISOString()).toBe('2026-09-02T07:15:42.123Z');
  });

  it('длительность приходит строкой и разбирается как целое', () => {
    // Наивное приведение дало бы NaN и списание на ноль.
    expect(parseCdr(cdr({ billsec: '60' })).billableSeconds).toBe(60);
  });

  it.each([
    ['нет поля', undefined],
    ['пустая строка', ''],
    ['не число', 'полторы минуты'],
    ['отрицательная', '-5'],
  ])('негодная длительность (%s) означает неотвеченный вызов, а не ошибку', (_name, value) => {
    // Ронять приём CDR из-за неразобранного поля хуже, чем принять вызов
    // как неотвеченный: расхождение видно в сверке, а потерянный CDR — нет.
    expect(parseCdr(cdr({ billsec: value })).billableSeconds).toBe(0);
  });

  it('нулевая отметка времени означает «события не было», а не 1970 год', () => {
    const parsed = parseCdr(cdr({ answer_stamp: '0000-00-00 00:00:00' }));
    expect(parsed.answeredAt).toBeUndefined();
  });

  it('отметка без пояса читается как UTC: узел работает в UTC по контракту', () => {
    const parsed = parseCdr(cdr({ end_stamp: '2026-09-02 12:00:00.000000' }));
    expect(parsed.endedAt?.toISOString()).toBe('2026-09-02T12:00:00.000Z');
  });

  it.each([
    ['тело не объект', 'строка'],
    ['тела нет', null],
    ['нет раздела variables', { channel_data: {} }],
    ['нет идентификатора вызова', { variables: { billsec: '10' } }],
  ])('%s — отказ разбора', (_name, body) => {
    expect(() => parseCdr(body)).toThrow(CdrParseError);
  });
});

describe('итог вызова по причине отбоя', () => {
  it('состоявшийся разговор тарифицируется независимо от причины отбоя', () => {
    // Платят за минуты. Чем закончился разговор — вопрос не тарификации.
    expect(statusFromHangupCause('NORMAL_CLEARING', 137)).toBe('completed');
    expect(statusFromHangupCause('MEDIA_TIMEOUT', 60)).toBe('completed');
  });

  it.each([
    ['USER_BUSY', 'busy'],
    ['NO_ANSWER', 'no_answer'],
    ['NO_USER_RESPONSE', 'no_answer'],
    ['ALLOTTED_TIMEOUT', 'no_answer'],
    ['ORIGINATOR_CANCEL', 'cancelled'],
    ['CALL_REJECTED', 'failed'],
    ['NETWORK_OUT_OF_ORDER', 'failed'],
  ])('%s без разговора → %s', (cause, expected) => {
    // Разделение не косметическое: занято означает, что абонент есть, а молчание
    // может означать, что SIM не проходит в сеть, — в расчёте ASR это разное.
    expect(statusFromHangupCause(cause, 0)).toBe(expected);
  });
});
