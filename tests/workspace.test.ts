/**
 * Проверки устройства монорепозитория.
 *
 * Правила ADR-0017 нельзя проверить внутри одного пакета: они про согласованность
 * между пакетами и настройками. Забытый псевдоним в vitest.shared.config.ts не ломает сборку —
 * он молча переключает тесты пакета на собранный `dist`, и они начинают проверять
 * предыдущую версию кода. Такое находится только специальной проверкой.
 *
 * Настройки читаются как текст, а не импортируются: файлы настроек лежат вне
 * типизированных проектов, и импорт из теста потянул бы за собой отдельный tsconfig
 * ради одной строки.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

interface PackageManifest {
  readonly name?: string;
  readonly exports?: Record<string, unknown>;
}

const manifests = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((dir): [string, PackageManifest] => [
    dir.name,
    JSON.parse(read('packages', dir.name, 'package.json')) as PackageManifest,
  ]);

const rootTsconfig = JSON.parse(read('tsconfig.json')) as { references?: { path: string }[] };
const aliasesSource = read('vitest.shared.config.ts');

describe('устройство монорепозитория (ADR-0017)', () => {
  it('пакеты найдены', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests)('%s: экспортирует собранный dist, а не исходники', (_dir, manifest) => {
    // Node не исполняет TypeScript: экспорт на ./src/*.ts означает приложение,
    // которое проходит все проверки и не запускается в production.
    const targets = JSON.stringify(manifest.exports ?? {});
    expect(targets).not.toContain('./src/');
    expect(targets).toContain('./dist/');
  });

  it.each(manifests)('%s: включён в сборку корневого tsconfig', (dir) => {
    const referenced = (rootTsconfig.references ?? []).map((reference) => reference.path);
    expect(referenced).toContain(`packages/${dir}`);
  });

  it.each(manifests)('%s: подменён на исходники в тестах', (_dir, manifest) => {
    // Без псевдонима тест возьмёт dist и будет проверять код до последней правки.
    expect(manifest.name).toBeDefined();
    expect(aliasesSource).toContain(`'${manifest.name ?? ''}':`);
  });

  it.each(manifests)('%s: файл, на который указывает псевдоним, существует', (dir) => {
    expect(existsSync(path.join(root, 'packages', dir, 'src', 'index.ts'))).toBe(true);
  });
});
