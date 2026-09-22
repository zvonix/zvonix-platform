/**
 * Учётные данные SIP и сборка каталога (ADR-0009).
 *
 * Здесь проверяется то, что ломается тихо: хеш, посчитанный не от той строки, даёт
 * шлюз, который просто «не регистрируется», а неэкранированное имя ломает документ
 * так, что узел молча остаётся без учётных записей.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSipUsername } from '@zvonix/shared';
import { directoryDocument, notFoundDocument } from './directory-xml.js';
import { a1Hash, escapeXmlAttribute, issueSipCredentials } from './sip-credentials.js';

const REALM = 'sip.zvonix.test';

describe('выпуск учётных данных', () => {
  it.each([
    ['gateway', 'gw'],
    ['channel', 'ch'],
  ] as const)('%s: имя узнаётся по приставке', (kind, prefix) => {
    const issued = issueSipCredentials(kind, REALM);
    expect(issued.username).toMatch(new RegExp(`^${prefix}-[a-z0-9]{12}$`));
    expect(isSipUsername(issued.username)).toBe(true);
  });

  it('длина имени постоянна на многих выпусках', () => {
    for (let i = 0; i < 3000; i += 1) {
      expect(issueSipCredentials('gateway', REALM).username).toMatch(/^gw-[a-z0-9]{12}$/);
    }
  });

  it('хеш считается ровно от «имя:realm:пароль»', () => {
    const issued = issueSipCredentials('gateway', REALM);
    const expected = createHash('md5')
      .update(`${issued.username}:${REALM}:${issued.password}`, 'utf8')
      .digest('hex');

    // Форма задана digest-проверкой SIP. Ошибка здесь не видна ничем, кроме того,
    // что шлюз «почему-то не регистрируется».
    expect(issued.a1Hash).toBe(expected);
    expect(issued.a1Hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('хеш зависит от realm: тот же пароль на другом realm даёт другой хеш', () => {
    // Отсюда требование к SIP_REALM быть общим на всю платформу: свой realm у каждого
    // узла означал бы, что учётная запись годится только на одном узле.
    expect(a1Hash('gw-aaaaaaaaaaaa', 'sip.one', 'пароль')).not.toBe(
      a1Hash('gw-aaaaaaaaaaaa', 'sip.two', 'пароль'),
    );
  });

  it('пароль достаточно длинный и не совпадает между выпусками', () => {
    const a = issueSipCredentials('gateway', REALM);
    const b = issueSipCredentials('gateway', REALM);
    expect(a.password.length).toBe(32);
    expect(a.password).not.toBe(b.password);
    expect(a.username).not.toBe(b.username);
  });
});

describe('экранирование XML', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&apos;'],
  ])('%s экранируется', (raw, escaped) => {
    expect(escapeXmlAttribute(raw)).toBe(escaped);
  });

  it('амперсанд не экранируется дважды', () => {
    expect(escapeXmlAttribute('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('документ каталога', () => {
  it('содержит a1-hash и не содержит пароля', () => {
    const issued = issueSipCredentials('gateway', REALM);
    const xml = directoryDocument(REALM, {
      username: issued.username,
      a1Hash: issued.a1Hash,
      variables: { zvonix_gateway: 'узел-1' },
    });

    expect(xml).toContain(`<param name="a1-hash" value="${issued.a1Hash}"/>`);
    // Открытый пароль не должен попадать на узел ни при каких условиях.
    expect(xml).not.toContain(issued.password);
    expect(xml).not.toContain('name="password"');
    expect(xml).toContain(`<user id="${issued.username}">`);
    expect(xml).toContain(`<domain name="${REALM}">`);
    expect(xml).toContain('<variable name="zvonix_gateway" value="узел-1"/>');
  });

  it('значение с кавычкой не ломает документ', () => {
    // Имя шлюза задаёт партнёр. Без экранирования кавычка разваливает документ,
    // а угловая скобка позволяет дописать в него своё.
    const xml = directoryDocument(REALM, {
      username: 'gw-aaaaaaaaaaaa',
      a1Hash: '0'.repeat(32),
      variables: { zvonix_name: 'ковычка " и <тег>' },
    });

    expect(xml).toContain('value="ковычка &quot; и &lt;тег&gt;"');
    expect(xml).not.toContain('<тег>');
  });

  it('ответ «записи нет» — валидный документ FreeSWITCH', () => {
    // Не пустое тело и не код ошибки: любой ответ кроме 200 mod_xml_curl отбрасывает
    // целиком и пишет ошибку в лог.
    const xml = notFoundDocument();
    expect(xml).toContain('<section name="result">');
    expect(xml).toContain('<result status="not found"/>');
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
  });
});
