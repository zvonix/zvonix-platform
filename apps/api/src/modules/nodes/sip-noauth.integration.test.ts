/**
 * Служба узла `zvonix-sip-noauth` целиком ([ADR-0127](../../../../../docs/adr/0127-invite-bez-parolya-blokiruetsya.md)):
 * настоящий скрипт из `node/install.sh` — `tail -F` журнала FreeSWITCH и awk-связка, — на временном журнале.
 *
 * Проверяется то, чего не видит модульный тест связки: служба переживает ротацию журнала. FreeSWITCH
 * переименовывает `freeswitch.log` в `.1` и заводит новый файл. Если бы служба держалась за старый файл,
 * брошенные каналы после первой ротации никто бы не считал, а служба выглядела бы живой.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

const INSTALL = path.join(import.meta.dirname, '..', '..', '..', '..', '..', 'node', 'install.sh');

// tail без inotify (Git Bash под Windows) замечает ротацию опросом раз в секунду — нужен запас.
vi.setConfig({ testTimeout: 60_000 });

/** Текст между `<<'<метка>'` и строкой `<метка>` в установщике узла. */
function heredoc(script: string, mark: string): string {
  const start = script.indexOf(`<<'${mark}'\n`);
  const end = script.indexOf(`\n${mark}\n`, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(script.indexOf('\n', start) + 1, end + 1);
}

/** Пара строк брошенного канала сканера (журнал узла 18.11.2026) с заданным uuid. */
function abandonedChannel(uuid: string, address: string): string {
  return [
    `${uuid} 2026-11-18 22:36:51.459656 97.87% [INFO] sofia.c:10460 sofia/zvonix/401810217197114163@217.197.114.163 receiving invite from ${address}:63540 version: 1.10.12-release git a88d069 2024-08-02 21:02:27Z 64bit call-id: 513077698-1616288481-573179027`,
    `${uuid} 2026-11-18 22:37:01.519633 97.93% [WARNING] switch_core_state_machine.c:684 ${uuid} sofia/zvonix/401810217197114163@217.197.114.163 Abandoned`,
    '',
  ].join('\n');
}

/** Ждать, пока в файле не станет `count` строк, — не дольше `ms`. */
async function linesWithin(file: string, count: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  let lines: string[] = [];
  while (Date.now() < deadline) {
    lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    if (lines.length >= count) break;
    await sleep(200);
  }
  return lines;
}

describe('служба zvonix-sip-noauth (ADR-0127)', () => {
  it('после ротации журнала FreeSWITCH продолжает считать брошенные каналы', async () => {
    const script = readFileSync(INSTALL, 'utf8');
    const directory = mkdtempSync(path.join(tmpdir(), 'zvonix-noauth-'));
    const fsLog = path.join(directory, 'freeswitch.log');
    const out = path.join(directory, 'sip-noauth.log');
    const program = path.join(directory, 'sip-noauth.awk');
    const service = path.join(directory, 'zvonix-sip-noauth');
    writeFileSync(fsLog, '');
    writeFileSync(out, '');
    writeFileSync(program, heredoc(script, 'NOAUTH_AWK'));
    const stop = path.join(directory, 'stop.pid');
    // Тот же скрипт, что ставит узел, с путями временного каталога вместо системных. Остановка — через
    // `tail --pid`: tail выходит, когда умирает сторожевой sleep, за ним по концу ввода — awk и sh. Снять
    // группу процессов сигналом под Git Bash нельзя: tail и awk остались бы жить после теста.
    const toPosix = (file: string) => file.split(path.sep).join('/');
    const body = heredoc(script, 'NOAUTH')
      .replace('/usr/local/lib/zvonix/sip-noauth.awk', toPosix(program))
      .replace('/var/log/zvonix/sip-noauth.log', toPosix(out));
    expect(body).toContain('tail -n 0 -F ');
    writeFileSync(
      service,
      `sleep 60 &\nSTOP=$!\necho "$STOP" >'${toPosix(stop)}'\nFS_LOG='${toPosix(fsLog)}'\n` +
        body.replace('tail -n 0 -F ', 'tail --pid="$STOP" -s 0.2 -n 0 -F '),
    );

    const child = spawn('sh', [toPosix(service)], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      // tail -n 0: строки, бывшие до запуска, не считаются.
      await sleep(1500);
      appendFileSync(
        fsLog,
        abandonedChannel('7e2e0ca0-dffa-4003-9b06-07b382f849b1', '37.187.220.233'),
      );
      expect(await linesWithin(out, 1, 10_000)).toEqual([
        '2026-11-18 22:37:01.519633 INVITE без авторизации от 37.187.220.233',
      ]);

      // Ротация, как у mod_logfile: старый файл переименован, новый заведён заново.
      renameSync(fsLog, `${fsLog}.1`);
      writeFileSync(fsLog, '');
      await sleep(2500);
      appendFileSync(
        fsLog,
        abandonedChannel('11111111-2222-4333-8444-555555555555', '179.43.153.250'),
      );
      expect(await linesWithin(out, 2, 15_000)).toEqual([
        '2026-11-18 22:37:01.519633 INVITE без авторизации от 37.187.220.233',
        '2026-11-18 22:37:01.519633 INVITE без авторизации от 179.43.153.250',
      ]);
    } finally {
      spawnSync('sh', ['-c', `kill "$(cat '${toPosix(stop)}')"`], { stdio: 'ignore' });
      await exited;
    }
  });
});
