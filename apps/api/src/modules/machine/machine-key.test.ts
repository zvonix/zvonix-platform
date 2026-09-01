/**
 * Разбор и сравнение машинных ключей (ADR-0019).
 *
 * Основное здесь — заголовок `Authorization` в двух видах. Ошибка разбора не выглядит
 * как ошибка: неверно разобранный ключ просто не проходит проверку, и отлаживается это
 * на живом узле, где видно только «звонки не идут».
 */

import { describe, expect, it } from 'vitest';
import { keyIdKind, keyIdTag } from '@zvonix/shared';
import {
  hashSecret,
  ipAllowed,
  issueKey,
  normalizeIp,
  readMachineKey,
  secretHashEquals,
} from './machine-key.js';

describe('выпуск ключа', () => {
  it.each(['node', 'client_api', 'enrollment'] as const)('%s: идентификатор узнаётся', (kind) => {
    const issued = issueKey(kind);
    expect(issued.keyId).toMatch(new RegExp(`^zvx_${keyIdTag(kind)}_[0-9a-z]{12}$`));
    expect(keyIdKind(issued.keyId)).toBe(kind);
  });

  it('секрет не хранится в открытом виде', () => {
    const issued = issueKey('node');
    expect(issued.secretHash).toBe(hashSecret(issued.secret));
    expect(issued.secretHash).not.toContain(issued.secret);
    // 32 байта в base64url — 43 символа. Меньше означало бы потерю энтропии.
    expect(issued.secret.length).toBe(43);
  });

  it('два выпуска не совпадают', () => {
    const a = issueKey('node');
    const b = issueKey('node');
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secret).not.toBe(b.secret);
  });

  it('секрет не содержит разделителей, по которым разбирается заголовок', () => {
    // base64url не содержит ни `:`, ни `.`, и на этом держится однозначность разбора.
    for (let i = 0; i < 50; i += 1) {
      const { secret } = issueKey('node');
      expect(secret).not.toContain(':');
      expect(secret).not.toContain('.');
    }
  });
});

describe('разбор заголовка Authorization', () => {
  it('Basic — единственное, что умеет FreeSWITCH', () => {
    const encoded = Buffer.from('zvx_node_abc123def456:s3cr3t', 'utf8').toString('base64');
    expect(readMachineKey(`Basic ${encoded}`)).toEqual({
      keyId: 'zvx_node_abc123def456',
      secret: 's3cr3t',
    });
  });

  it('Bearer — для нашего агента, который заголовок задать умеет', () => {
    expect(readMachineKey('Bearer zvx_node_abc123def456.s3cr3t')).toEqual({
      keyId: 'zvx_node_abc123def456',
      secret: 's3cr3t',
    });
  });

  it('настоящий выпущенный ключ проходит оба вида', () => {
    const issued = issueKey('node');
    const basic = Buffer.from(`${issued.keyId}:${issued.secret}`, 'utf8').toString('base64');

    expect(readMachineKey(`Basic ${basic}`)).toEqual({
      keyId: issued.keyId,
      secret: issued.secret,
    });
    expect(readMachineKey(`Bearer ${issued.keyId}.${issued.secret}`)).toEqual({
      keyId: issued.keyId,
      secret: issued.secret,
    });
  });

  it.each([
    ['заголовка нет', undefined],
    ['пустая строка', ''],
    ['схема не та', 'Digest zvx_node_a.b'],
    ['без разделителя', 'Bearer zvx_node_abc123'],
    ['пустой секрет', 'Bearer zvx_node_abc123.'],
    ['пустой идентификатор', 'Bearer .s3cr3t'],
    ['Basic без разделителя', `Basic ${Buffer.from('простотекст', 'utf8').toString('base64')}`],
    ['Basic с пустым секретом', `Basic ${Buffer.from('zvx_node_a:', 'utf8').toString('base64')}`],
  ])('%s — не разбирается', (_name, header) => {
    expect(readMachineKey(header)).toBeUndefined();
  });

  it('лишние пробелы вокруг заголовка не мешают', () => {
    expect(readMachineKey('  Bearer zvx_node_abc.s3cr3t  ')?.keyId).toBe('zvx_node_abc');
  });
});

describe('сравнение секретов', () => {
  it('совпадающие хеши равны, различающиеся — нет', () => {
    expect(secretHashEquals(hashSecret('один'), hashSecret('один'))).toBe(true);
    expect(secretHashEquals(hashSecret('один'), hashSecret('другой'))).toBe(false);
  });

  it('разная длина не роняет сравнение', () => {
    expect(secretHashEquals('коротко', hashSecret('длинно'))).toBe(false);
  });
});

describe('список разрешённых адресов', () => {
  it('пустой список означает «откуда угодно»', () => {
    expect(ipAllowed([], '203.0.113.7')).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it('непустой список пропускает только перечисленное', () => {
    expect(ipAllowed(['203.0.113.7'], '203.0.113.7')).toBe(true);
    expect(ipAllowed(['203.0.113.7'], '203.0.113.8')).toBe(false);
  });

  it('без адреса непустой список не проходится', () => {
    expect(ipAllowed(['203.0.113.7'], undefined)).toBe(false);
  });

  it('IPv4 через IPv6-сокет совпадает с записью в привычном виде', () => {
    // Без приведения список, заполненный человеком, не совпал бы никогда —
    // а это отказ телефонии, а не отказ злоумышленнику.
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipAllowed(['203.0.113.7'], '::ffff:203.0.113.7')).toBe(true);
    expect(ipAllowed(['::ffff:203.0.113.7'], '203.0.113.7')).toBe(true);
  });

  it('регистр IPv6 не влияет', () => {
    expect(ipAllowed(['2001:DB8::1'], '2001:db8::1')).toBe(true);
  });

  it('частичное совпадение не проходит', () => {
    // Проверка обязана быть по равенству, а не по вхождению подстроки:
    // иначе `10.0.0.1` открыл бы доступ и `110.0.0.1`.
    expect(ipAllowed(['10.0.0.1'], '110.0.0.1')).toBe(false);
    expect(ipAllowed(['10.0.0.1'], '10.0.0.10')).toBe(false);
  });
});
