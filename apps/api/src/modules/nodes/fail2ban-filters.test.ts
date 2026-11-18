/**
 * Фильтры fail2ban узла (`node/fail2ban/filter.d`) на строках журнала FreeSWITCH ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md)).
 *
 * fail2ban пишет регулярные выражения в синтаксисе Python, а здесь они проверяются движком JavaScript: оба
 * понимают то, что в фильтрах есть (просмотр вперёд, классы, `\s`, `\d`). Подстановка — как у fail2ban:
 * `%%` — один знак процента, `<HOST>` — адрес. Дату fail2ban вырезает по `datepattern` до сравнения, поэтому
 * строки ниже — без даты, но с хвостом «загрузка процессора и уровень», как пишет FreeSWITCH 1.10.12.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILTERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../node/fail2ban/filter.d',
);

/** Выражения `failregex` фильтра: первая строка после «=» и строки продолжения с отступом. */
function failregex(name: string): RegExp[] {
  const text = readFileSync(path.join(FILTERS, `${name}.conf`), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('failregex'));
  const patterns: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (index === start) patterns.push(line.replace(/^failregex\s*=\s*/u, ''));
    else if (/^\s+\S/u.test(line)) patterns.push(line.trim());
    else break;
  }
  return patterns.map(
    (pattern) =>
      new RegExp(
        pattern.replaceAll('%%', '%').replaceAll('<HOST>', '(?<host>[0-9a-fA-F.:]+)'),
        'u',
      ),
  );
}

/** Адрес, который fail2ban посчитал бы по строке, или `undefined` — строка не считается. */
function hostOf(filter: RegExp[], line: string): string | undefined {
  for (const pattern of filter) {
    const found = pattern.exec(line);
    if (found !== null) return found.groups?.host;
  }
  return undefined;
}

const FOREIGN = failregex('zvonix-freeswitch');
const KNOWN = failregex('zvonix-freeswitch-known');

/** Строки журнала узла 217.197.114.163 за 18.11.2026 (разбор ведущей сессии), без даты. */
const LINES = {
  /** Таймаут каталога у живого клиента: учётная запись не пришла. */
  clientNotFound:
    " 0.47% [WARNING] sofia_reg.c:3210 Can't find user [ch-or2hggbrys9g@sip.zvonix.local] from 94.198.51.21",
  /** Следом за ним — отказ INVITE; в скобках номер назначения, а не логин. */
  clientInvite:
    " 0.47% [WARNING] sofia_reg.c:1787 SIP auth failure (INVITE) on sofia profile 'zvonix' for [+79330980320@sip.zvonix.com] from ip 94.198.51.21",
  /** Партнёр: таймаут каталога на REGISTER. */
  partnerNotFound:
    " 1.20% [WARNING] sofia_reg.c:3210 Can't find user [pt-k3m9q2w7x4ab@sip.zvonix.local] from 31.216.170.27",
  /** Сканер: чужой логин на REGISTER — образец ADR-0051. */
  scannerRegister:
    " 11.43% [WARNING] sofia_reg.c:1787 SIP auth failure (REGISTER) on sofia profile 'zvonix' for [150@78.17.98.160] from ip 51.15.21.79",
  /** Сканер: чужой логин через INVITE — «Can't find user» приходит первым. */
  scannerNotFound:
    " 3.10% [WARNING] sofia_reg.c:3210 Can't find user [1001@217.197.114.163] from 45.95.147.220",
  /** Шлюз партнёра со старым паролем. */
  partnerRegister:
    " 2.00% [WARNING] sofia_reg.c:1787 SIP auth failure (REGISTER) on sofia profile 'zvonix' for [gw-a1b2c3d4e5f6@sip.zvonix.local] from ip 31.216.170.27",
  /** Подбор пароля к существующей линии через INVITE: только эта строка, «Can't find user» нет. */
  bruteInvite:
    " 0.90% [WARNING] sofia_reg.c:1787 SIP auth failure (INVITE) on sofia profile 'zvonix' for [79001234567@217.197.114.163] from ip 185.243.5.12",
};

describe('фильтры fail2ban узла (ADR-0125)', () => {
  it('таймаут каталога у живого клиента не считается чужим логином — блока на сутки нет', () => {
    expect(hostOf(FOREIGN, LINES.clientNotFound)).toBeUndefined();
    expect(hostOf(FOREIGN, LINES.clientInvite)).toBeUndefined();
    // Обе строки — в тюрьме своих логинов, где порог — атака.
    expect(hostOf(KNOWN, LINES.clientNotFound)).toBe('94.198.51.21');
    expect(hostOf(KNOWN, LINES.clientInvite)).toBe('94.198.51.21');
  });

  it('партнёр со старым паролем или таймаутом — только тюрьма своих логинов', () => {
    for (const line of [LINES.partnerNotFound, LINES.partnerRegister]) {
      expect(hostOf(FOREIGN, line)).toBeUndefined();
      expect(hostOf(KNOWN, line)).toBe('31.216.170.27');
    }
  });

  it('сканер с чужими логинами блокируется как раньше', () => {
    expect(hostOf(FOREIGN, LINES.scannerRegister)).toBe('51.15.21.79');
    expect(hostOf(FOREIGN, LINES.scannerNotFound)).toBe('45.95.147.220');
    expect(hostOf(KNOWN, LINES.scannerRegister)).toBeUndefined();
    expect(hostOf(KNOWN, LINES.scannerNotFound)).toBeUndefined();
  });

  it('подбор пароля через INVITE к существующей линии не остаётся без счёта', () => {
    expect(hostOf(FOREIGN, LINES.bruteInvite)).toBeUndefined();
    expect(hostOf(KNOWN, LINES.bruteInvite)).toBe('185.243.5.12');
  });

  it('каждая строка отказа считается ровно одной тюрьмой — двойного счёта нет', () => {
    for (const line of Object.values(LINES)) {
      const counted = [hostOf(FOREIGN, line), hostOf(KNOWN, line)].filter(
        (host) => host !== undefined,
      );
      expect(counted).toHaveLength(1);
    }
  });
});
