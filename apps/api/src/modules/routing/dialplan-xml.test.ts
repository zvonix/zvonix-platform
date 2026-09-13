/**
 * Документы, которые узел получает от control plane.
 *
 * Оба вида XML собираются конкатенацией строк — полноценный сериализатор ради десятка
 * тегов избыточен. Расплата за это в том, что сломать документ можно чем угодно:
 * кавычкой в имени шлюза, угловой скобкой в имени канала, значением из чужого ввода.
 *
 * **Невалидный документ FreeSWITCH отбрасывает молча.** Ни ошибки, ни отказа — просто
 * вызов не проходит, а причина не видна ниоткуда. Поэтому здесь каждый документ
 * разбирается настоящим парсером XML, а не проверяется вхождением подстрок.
 */

import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { describe, expect, it } from 'vitest';
import { CALL_FAILURE_REASONS } from '@zvonix/shared';
import { directoryDocument, notFoundDocument } from '../telephony/directory-xml.js';
import { rejectDocument, routeDocument, sipResponseFor } from './dialplan-xml.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

/**
 * Разбирает документ настоящим парсером.
 *
 * Сначала проверка синтаксиса, потом разбор: сам разборщик к невалидному XML снисходителен
 * и молча вернёт что-нибудь, а нам нужно ровно обратное — узнать, что документ сломан,
 * потому что FreeSWITCH его так же молча выбросит.
 */
function parse(xml: string): unknown {
  SyntaxValidator.validate(xml);
  return parser.parse(xml);
}

const plan = {
  callId: '0198f3c4-1111-7000-8000-aaaaaaaaaaaa',
  destination: '79001234567',
  realm: 'sip.zvonix.test',
  callerId: null,
  recordingPath: null,
  candidates: [{ kind: 'sim' as const, gatewaySipUsername: 'gw-aaaaaaaaaaaa' }],
};

describe('диалплан с маршрутом', () => {
  it('валиден и содержит одну попытку на кандидата', () => {
    const xml = routeDocument({
      ...plan,
      candidates: [
        { kind: 'sim' as const, gatewaySipUsername: 'gw-aaaaaaaaaaaa' },
        { kind: 'sim' as const, gatewaySipUsername: 'gw-bbbbbbbbbbbb' },
      ],
    });
    expect(() => parse(xml)).not.toThrow();

    // Разделитель `|` означает «пробовать по очереди»: перебор выполняет узел.
    expect(xml).toContain(
      'data="user/gw-aaaaaaaaaaaa@sip.zvonix.test|user/gw-bbbbbbbbbbbb@sip.zvonix.test"',
    );
  });

  it('идентификатор вызова экспортируется: без него не связать разговор, деньги и запись', () => {
    expect(routeDocument(plan)).toContain(`nolocal:zvonix_call_id=${plan.callId}`);
  });

  it('запись включается только когда её требует канал', () => {
    expect(routeDocument(plan)).not.toContain('record_session');
    const withRecording = routeDocument({ ...plan, recordingPath: '/var/lib/zvonix/rec/a.wav' });
    expect(withRecording).toContain('record_session');
    expect(() => parse(withRecording)).not.toThrow();
  });

  it('свой CallerID подставляется, когда задан каналом', () => {
    const xml = routeDocument({ ...plan, callerId: '79001112233' });
    expect(xml).toContain('effective_caller_id_number=79001112233');
  });

  it('имя шлюза с кавычкой не разваливает документ', () => {
    // Имя учётной записи выдаём мы, но полагаться на это нельзя: значение попадает
    // в атрибут, и незакрытая кавычка сделала бы документ невалидным — а FreeSWITCH
    // выбросил бы его молча.
    const xml = routeDocument({
      ...plan,
      candidates: [{ kind: 'sim' as const, gatewaySipUsername: 'gw-"><evil' }],
    });
    expect(() => parse(xml)).not.toThrow();
    expect(xml).not.toContain('<evil');
  });
});

describe('диалплан с отказом', () => {
  it.each(CALL_FAILURE_REASONS)('%s: документ валиден и несёт причину', (reason) => {
    const xml = rejectDocument(reason);
    expect(() => parse(xml)).not.toThrow();

    // Причина остаётся переменной канала и возвращается в CDR: абонент видит
    // грубый код SIP, поддержка — точную причину.
    expect(xml).toContain(`zvonix_reject_reason=${reason}`);
    expect(xml).toContain(sipResponseFor(reason));
  });

  it('у каждой причины есть свой код SIP', () => {
    for (const reason of CALL_FAILURE_REASONS) {
      expect(sipResponseFor(reason)).toMatch(/^\d{3} /);
    }
  });

  it('деньги и чёрный список не раскрываются звонящему', () => {
    // Сообщать, что у клиента кончились деньги или что номер запрещён, не следует:
    // коды намеренно грубее причин.
    expect(sipResponseFor('insufficient_funds')).toBe('402 Payment Required');
    expect(sipResponseFor('destination_blocked')).toBe('403 Forbidden');
  });
});

describe('каталог учётных записей', () => {
  it('валиден и отдаёт a1-hash вместо пароля', () => {
    const xml = directoryDocument('sip.zvonix.test', {
      username: 'gw-aaaaaaaaaaaa',
      a1Hash: '0'.repeat(32),
      variables: { zvonix_gateway: '0198f3c4', zvonix_gateway_type: 'goip' },
    });
    expect(() => parse(xml)).not.toThrow();
    expect(xml).toContain('name="a1-hash"');
    expect(xml).not.toContain('name="password"');
  });

  it('значение переменной из чужого ввода не ломает документ', () => {
    const xml = directoryDocument('sip.zvonix.test', {
      username: 'ch-aaaaaaaaaaaa',
      a1Hash: '0'.repeat(32),
      variables: { zvonix_name: 'кавычка " и <тег> и & амперсанд' },
    });
    expect(() => parse(xml)).not.toThrow();
  });

  it('«записи нет» — валидный документ, а не пустой ответ', () => {
    // Любой код кроме 200 и любое неразбираемое тело узел отбрасывает целиком
    // и пишет ошибку в лог. «Записи нет» — штатный ответ, а не сбой.
    const xml = notFoundDocument();
    expect(() => parse(xml)).not.toThrow();
    expect(xml).toContain('<result status="not found"/>');
  });
});
