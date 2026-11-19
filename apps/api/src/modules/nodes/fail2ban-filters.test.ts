/**
 * Фильтры fail2ban узла (`node/fail2ban/filter.d`) на строках журнала FreeSWITCH ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md))
 * и связка INVITE без пароля — awk службы `zvonix-sip-noauth` из `node/install.sh` ([ADR-0127](../../../../../docs/adr/0127-invite-bez-parolya-blokiruetsya.md)).
 *
 * fail2ban пишет регулярные выражения в синтаксисе Python, а здесь они проверяются движком JavaScript: оба
 * понимают то, что в фильтрах есть (просмотр вперёд, классы, `\s`, `\d`). Подстановка — как у fail2ban:
 * `%%` — один знак процента, `<HOST>` — адрес. Дату fail2ban вырезает по `datepattern` до сравнения, поэтому
 * строки ниже — без даты, но с хвостом «загрузка процессора и уровень», как пишет FreeSWITCH 1.10.12.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../node');
const FILTERS = path.join(NODE_DIR, 'fail2ban/filter.d');

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
const NOAUTH = failregex('zvonix-freeswitch-noauth');

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

/**
 * Программа awk службы `zvonix-sip-noauth` — как её раскладывает `node/install.sh`: текст между
 * `<<'NOAUTH_AWK'` и `NOAUTH_AWK`. Кавычки у метки — подстановок внутри нет, текст идёт на узел как есть.
 */
function noauthProgram(): string {
  const script = readFileSync(path.join(NODE_DIR, 'install.sh'), 'utf8');
  const start = script.indexOf("<<'NOAUTH_AWK'\n");
  const end = script.indexOf('\nNOAUTH_AWK\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(script.indexOf('\n', start) + 1, end + 1);
}

/**
 * Какие awk есть рядом: на Ubuntu по умолчанию mawk, у узла 217.197.114.163 — gawk. Проверяется каждый
 * найденный, а не только первый: программа обязана работать на обоих.
 */
const AWKS = ['awk', 'mawk', 'gawk'].filter(
  (name) => spawnSync(name, ['BEGIN { exit 0 }'], { stdio: 'ignore' }).status === 0,
);

/** Строки журнала FreeSWITCH через awk службы — её вывод построчно. */
function noauthLines(awk: string, lines: readonly string[]): string[] {
  const result = spawnSync(awk, [noauthProgram()], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout.split('\n').filter((line) => line !== '');
}

/** Что fail2ban сделал бы со строкой службы: дату вырезает `datepattern`, остальное сравнивается. */
function noauthHost(line: string): string | undefined {
  return hostOf(NOAUTH, line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+/u, ''));
}

/** Журнал узла 217.197.114.163 за 18–19.11.2026 — строки как есть, с uuid канала в начале. */
const SCANNER_UUID = '7e2e0ca0-dffa-4003-9b06-07b382f849b1';
const SCANNER = [
  `${SCANNER_UUID} 2026-11-18 22:36:51.459656 97.87% [NOTICE] switch_channel.c:1142 New Channel sofia/zvonix/401810217197114163@217.197.114.163 [${SCANNER_UUID}]`,
  `${SCANNER_UUID} 2026-11-18 22:36:51.459656 97.87% [INFO] sofia.c:10460 sofia/zvonix/401810217197114163@217.197.114.163 receiving invite from 37.187.220.233:63540 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 513077698-1616288481-573179027`,
  "2026-11-18 22:36:51.459656 97.87% [WARNING] sofia_reg.c:1842 SIP auth challenge (INVITE) on sofia profile 'zvonix' for [401810927597580097@217.197.114.163] from ip 37.187.220.233",
  `${SCANNER_UUID} 2026-11-18 22:37:01.519633 97.93% [WARNING] switch_core_state_machine.c:684 ${SCANNER_UUID} sofia/zvonix/401810217197114163@217.197.114.163 Abandoned`,
  `${SCANNER_UUID} 2026-11-18 22:37:01.519633 97.93% [NOTICE] switch_core_state_machine.c:687 Hangup sofia/zvonix/401810217197114163@217.197.114.163 [CS_NEW] [WRONG_CALL_STATE]`,
  `${SCANNER_UUID} 2026-11-18 22:37:01.519633 97.93% [NOTICE] switch_core_session.c:1762 Session 540 (sofia/zvonix/401810217197114163@217.197.114.163) Ended`,
  `${SCANNER_UUID} 2026-11-18 22:37:01.519633 97.93% [NOTICE] switch_core_session.c:1766 Close Channel sofia/zvonix/401810217197114163@217.197.114.163 [CS_DESTROY]`,
];

/** Свой клиент: 407, повторный INVITE с паролем, диалплан. Строки без даты (EXECUTE) тоже бывают. */
const CLIENT_UUID = 'afda1d64-218a-4d79-9e88-46f1588762a3';
const CLIENT = [
  `${CLIENT_UUID} 2026-11-18 06:46:23.378193 98.00% [NOTICE] switch_channel.c:1142 New Channel sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013 [${CLIENT_UUID}]`,
  `${CLIENT_UUID} 2026-11-18 06:46:23.378193 98.00% [INFO] sofia.c:10460 sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013 receiving invite from 94.198.51.21:5013 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 7b670b2054d790c17c12e2821377e460@sip.zvonix.com`,
  "2026-11-18 06:46:23.378193 98.00% [WARNING] sofia_reg.c:1842 SIP auth challenge (INVITE) on sofia profile 'zvonix' for [+79232156991@sip.zvonix.com] from ip 94.198.51.21",
  `${CLIENT_UUID} 2026-11-18 06:46:23.398157 98.00% [INFO] sofia.c:10460 sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013 receiving invite from 94.198.51.21:5013 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 7b670b2054d790c17c12e2821377e460@sip.zvonix.com`,
  `${CLIENT_UUID} 2026-11-18 06:46:23.438258 98.00% [INFO] mod_dialplan_xml.c:639 Processing ch-or2hggbrys9g <ch-or2hggbrys9g>->+79232156991 in context zvonix`,
  `${CLIENT_UUID} EXECUTE [depth=0] sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013 set(zvonix_reject_reason=numbers_exhausted)`,
  `${CLIENT_UUID} 2026-11-18 06:46:23.598154 97.87% [INFO] mod_json_cdr.c:272 Process [${CLIENT_UUID}.cdr.json]`,
  `${CLIENT_UUID} 2026-11-18 06:46:23.658133 97.87% [NOTICE] switch_core_session.c:1762 Session 14649 (sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013) Ended`,
  `${CLIENT_UUID} 2026-11-18 06:46:23.658133 97.87% [NOTICE] switch_core_session.c:1766 Close Channel sofia/zvonix/ch-or2hggbrys9g@sip.zvonix.com:5013 [CS_DESTROY]`,
];

/** Ответил на 407, но пароль не подошёл: отказ сразу, канал не бросается — это не «без пароля». */
const REJECTED_UUID = 'a75b670c-9490-4e89-9677-7a163d04d1c1';
const REJECTED = [
  `${REJECTED_UUID} 2026-11-18 12:12:26.158167 97.93% [NOTICE] switch_channel.c:1142 New Channel sofia/zvonix/5002@0.0.0.0:56852 [${REJECTED_UUID}]`,
  `${REJECTED_UUID} 2026-11-18 12:12:26.158167 97.93% [INFO] sofia.c:10460 sofia/zvonix/5002@0.0.0.0:56852 receiving invite from 45.61.187.19:56852 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 645f48def96e43a69d05a2c9ed5d3f0f@0.0.0.0`,
  `${REJECTED_UUID} 2026-11-18 12:12:26.338167 97.93% [INFO] sofia.c:10460 sofia/zvonix/5002@0.0.0.0:56852 receiving invite from 45.61.187.19:56852 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 645f48def96e43a69d05a2c9ed5d3f0f@0.0.0.0`,
  `${REJECTED_UUID} 2026-11-18 12:12:26.398169 97.93% [NOTICE] sofia.c:2417 Hangup sofia/zvonix/5002@0.0.0.0:56852 [CS_NEW] [CALL_REJECTED]`,
  `${REJECTED_UUID} 2026-11-18 12:12:26.418161 97.93% [NOTICE] switch_core_session.c:1762 Session 16032 (sofia/zvonix/5002@0.0.0.0:56852) Ended`,
  `${REJECTED_UUID} 2026-11-18 12:12:26.418161 97.93% [NOTICE] switch_core_session.c:1766 Close Channel sofia/zvonix/5002@0.0.0.0:56852 [CS_DESTROY]`,
];

/** Пара строк сканера (INVITE и бросок) с другим uuid и временем — для проверок порядка и чистки. */
function scannerChannel(uuid: string, invite: string, abandoned: string): [string, string] {
  const inviteLine = SCANNER[1] ?? '';
  const abandonedLine = SCANNER[3] ?? '';
  return [
    inviteLine.replaceAll(SCANNER_UUID, uuid).replace('2026-11-18 22:36:51', invite),
    abandonedLine.replaceAll(SCANNER_UUID, uuid).replace('2026-11-18 22:37:01', abandoned),
  ];
}

const SCANNER_OUT = '2026-11-18 22:37:01.519633 INVITE без авторизации от 37.187.220.233';

describe('INVITE без пароля: связка службы zvonix-sip-noauth и фильтр (ADR-0127)', () => {
  it('awk для проверки найден', () => {
    expect(AWKS.length).toBeGreaterThan(0);
  });

  for (const awk of AWKS) {
    describe(awk, () => {
      it('брошенный канал сканера — одна строка с его адресом и временем броска', () => {
        expect(noauthLines(awk, SCANNER)).toEqual([SCANNER_OUT]);
      });

      it('свой клиент, ответивший на 407, и неверный пароль строк не дают', () => {
        expect(noauthLines(awk, [...CLIENT, ...REJECTED])).toEqual([]);
      });

      it('каналы вперемешку: адрес берётся по uuid, а не по соседней строке', () => {
        const [otherInvite, otherAbandoned] = scannerChannel(
          '11111111-2222-4333-8444-555555555555',
          '2026-11-18 22:36:52',
          '2026-11-18 22:37:02',
        );
        // Клиент — в те же секунды: строки одного журнала идут по времени.
        const sameTime = (line: string) =>
          line.replace('2026-11-18 06:46:23', '2026-11-18 22:36:55');
        const mixed = [
          SCANNER[1] ?? '',
          sameTime(CLIENT[1] ?? ''),
          otherInvite.replace('37.187.220.233', '179.43.153.250'),
          sameTime(CLIENT[8] ?? ''),
          SCANNER[3] ?? '',
          otherAbandoned,
        ];
        expect(noauthLines(awk, mixed)).toEqual([
          SCANNER_OUT,
          '2026-11-18 22:37:02.519633 INVITE без авторизации от 179.43.153.250',
        ]);
      });

      it('закрытый канал забывается: «Abandoned» после «Close Channel» не считается', () => {
        expect(noauthLines(awk, [SCANNER[1] ?? '', SCANNER[6] ?? '', SCANNER[3] ?? ''])).toEqual(
          [],
        );
      });

      it('запись старше 5 минут без «Close Channel» удаляет чистка — память не растёт', () => {
        // «Close Channel» потерялась; через 6 минут любая строка запускает чистку, и поздний «Abandoned»
        // того же канала уже не находит адреса.
        const lost = '99999999-8888-4777-8666-555555555555';
        const [invite, abandoned] = scannerChannel(
          lost,
          '2026-11-18 22:00:00',
          '2026-11-18 22:06:30',
        );
        const [later] = scannerChannel(SCANNER_UUID, '2026-11-18 22:06:01', '2026-11-18 22:06:20');
        expect(noauthLines(awk, [invite, later, abandoned])).toEqual([]);
        // Та же пара, но запись моложе 5 минут, — считается.
        const [, fresh] = scannerChannel(lost, '2026-11-18 22:00:00', '2026-11-18 22:04:30');
        const [early] = scannerChannel(SCANNER_UUID, '2026-11-18 22:04:01', '2026-11-18 22:04:20');
        expect(noauthLines(awk, [invite, early, fresh])).toHaveLength(1);
      });

      it('полночь и смена месяца не ломают время: считается по дате строки', () => {
        const [invite, abandoned] = scannerChannel(
          SCANNER_UUID,
          '2026-11-30 23:59:55',
          '2026-12-01 00:00:05',
        );
        expect(noauthLines(awk, [invite, abandoned])).toEqual([
          '2026-12-01 00:00:05.519633 INVITE без авторизации от 37.187.220.233',
        ]);
      });

      it('подставной текст в номере или call-id не приписывает канал чужому адресу', () => {
        const invite = SCANNER[1] ?? '';
        const abandoned = SCANNER[3] ?? '';
        const inName = invite.replace(
          'sofia/zvonix/401810217197114163@217.197.114.163 receiving',
          'sofia/zvonix/1 receiving invite from 94.198.51.21:5060 version: x receiving',
        );
        const inCallId = `${invite} receiving invite from 94.198.51.21:5060 version: x`;
        for (const forged of [inName, inCallId]) {
          expect(noauthLines(awk, [forged, abandoned])).toEqual([]);
        }
      });
    });
  }

  it('строку службы считает только тюрьма INVITE без пароля', () => {
    expect(noauthHost(SCANNER_OUT)).toBe('37.187.220.233');
    const withoutDate = SCANNER_OUT.slice('2026-11-18 22:37:01.519633'.length);
    expect(hostOf(FOREIGN, withoutDate)).toBeUndefined();
    expect(hostOf(KNOWN, withoutDate)).toBeUndefined();
    expect(noauthHost('2026-11-18 22:37:01.519633 INVITE без авторизации от 2001:db8::7')).toBe(
      '2001:db8::7',
    );
  });

  it('строки самого FreeSWITCH тюрьма INVITE без пароля не считает', () => {
    for (const line of [...SCANNER, ...CLIENT, ...REJECTED, ...Object.values(LINES)]) {
      expect(noauthHost(line)).toBeUndefined();
    }
  });
});
