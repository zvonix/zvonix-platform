/**
 * Причина отказа на шаге денег (ADR-0126): «нет денег» — только настоящая нехватка.
 */

import { describe, expect, it } from 'vitest';
import { conflict, notFound } from '@zvonix/shared';
import { failureReasonFor } from './routing.service.js';

describe('причина отказа на шаге денег', () => {
  it('нехватка денег — «нет денег»', () => {
    expect(
      failureReasonFor(
        conflict('Недостаточно средств', { details: { reason: 'insufficient_funds' } }),
      ),
    ).toBe('insufficient_funds');
  });

  it('прочий конфликт — не «нет денег», а внутренняя ошибка', () => {
    // Прежде любой `conflict` назывался нехваткой денег, и поддержка искала деньги там, где сломано другое.
    expect(failureReasonFor(conflict('Ключ уже занят'))).toBe('internal_error');
  });

  it('нет строки цены или правила наценки — «нет цены»', () => {
    expect(failureReasonFor(notFound('Нет действующего правила наценки'))).toBe('no_tariff');
  });

  it('не доменная ошибка — внутренняя', () => {
    expect(failureReasonFor(new Error('сеть'))).toBe('internal_error');
  });
});
