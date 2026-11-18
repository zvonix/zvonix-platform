import { describe, expect, it } from 'vitest';
import { parseBans } from './node-bans.service.js';

describe('список блокировок узла (ADR-0125)', () => {
  it('ответ zvonix-bans: тюрьма, адрес, до какого времени', () => {
    const found = parseBans(
      [
        'ИТОГ: блокировок 3',
        'f 45.95.147.220 1795000000',
        'k 31.216.170.27 -',
        's 2001:db8::7 1795003600',
      ].join('\n'),
    );
    expect(found.available).toBe(true);
    expect(found.total).toBe(3);
    expect(found.bans).toEqual([
      { jail: 'sip_foreign', address: '45.95.147.220', until: new Date(1_795_000_000_000) },
      { jail: 'sip_known', address: '31.216.170.27', until: null },
      { jail: 'ssh', address: '2001:db8::7', until: new Date(1_795_003_600_000) },
    ]);
  });

  it('строки не по форме пропускаются: в кабинет уходит только адрес', () => {
    const found = parseBans('ИТОГ: блокировок 2\nf not-an-ip 1\nx 1.2.3.4 1\nf 1.2.3.4 1');
    expect(found.bans.map((ban) => ban.address)).toEqual(['1.2.3.4']);
  });

  it('узел без нового набора отвечает -ERR — так и говорим, а не «блокировок нет»', () => {
    const found = parseBans('-ERR NODE_REFUSED');
    expect(found.available).toBe(false);
    expect(found.message).toMatch(/не обновился/u);
  });

  it('узел без fail2ban — его же словами', () => {
    const found = parseBans('ИТОГ: fail2ban на узле не установлен');
    expect(found.available).toBe(false);
    expect(found.message).toBe('fail2ban на узле не установлен');
  });
});
