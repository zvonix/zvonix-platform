/**
 * Граница клиентского контура для причин отказа.
 *
 * Проверяется не перевод как таковой, а его умолчание: новая внутренняя причина
 * обязана оказаться скрытой сама, без правки этого файла. Обратное — прямой путь
 * к тому, что однажды клиенту покажут «нет свободной SIM».
 */

import { describe, expect, it } from 'vitest';
import { CALL_FAILURE_REASONS, CLIENT_FAILURE_REASONS, clientFailureReasonOf } from './call.js';

describe('причина отказа в клиентском контуре', () => {
  it('показывает как есть то, что относится к самому клиенту', () => {
    expect(clientFailureReasonOf('insufficient_funds')).toBe('insufficient_funds');
    expect(clientFailureReasonOf('limit_exceeded')).toBe('limit_exceeded');
    expect(clientFailureReasonOf('operator_not_allowed')).toBe('operator_not_allowed');
    expect(clientFailureReasonOf('destination_blocked')).toBe('destination_blocked');
    expect(clientFailureReasonOf('operator_unconfirmed')).toBe('operator_unconfirmed');
  });

  it('скрывает устройство нашей стороны', () => {
    expect(clientFailureReasonOf('no_sim_available')).toBe('platform');
    expect(clientFailureReasonOf('no_coverage')).toBe('platform');
    expect(clientFailureReasonOf('no_tariff')).toBe('platform');
    expect(clientFailureReasonOf('node_lost')).toBe('platform');
    expect(clientFailureReasonOf('internal_error')).toBe('platform');
    expect(clientFailureReasonOf('recording_required')).toBe('platform');
    expect(clientFailureReasonOf('channel_unknown')).toBe('platform');
  });

  it('неразобранный номер клиент видит как есть: это про его набор, а не про нашу ёмкость', () => {
    expect(clientFailureReasonOf('destination_invalid')).toBe('destination_invalid');
  });

  it('переводит любую причину во что-то из клиентского набора', () => {
    for (const reason of CALL_FAILURE_REASONS) {
      expect(CLIENT_FAILURE_REASONS).toContain(clientFailureReasonOf(reason));
    }
  });
});
