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

interface Tsconfig {
  readonly compilerOptions?: Record<string, unknown>;
  readonly exclude?: string[];
  readonly references?: { path: string }[];
}

/**
 * Убирает построчные комментарии, которых в JSON нет, а в tsconfig они есть:
 * формат там — JSONC, и все настройки проекта им пользуются.
 *
 * Учитывается строковый литерал: `"https://json.schemastore.org/tsconfig"`
 * содержит две косые черты и комментарием не является.
 */
function stripComments(text: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (inString) {
      result += character;
      if (character === '\\') {
        result += text[index + 1] ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    result += character;
  }
  return result;
}

const readTsconfig = (...parts: string[]): Tsconfig =>
  JSON.parse(stripComments(read(...parts))) as Tsconfig;

/**
 * Ссылка на проект — либо каталог с `tsconfig.json`, либо сам файл настройки.
 * Так их разрешает и TypeScript.
 */
const configPathOf = (project: string): string[] =>
  project.endsWith('.json') ? [project] : [...project.split('/'), 'tsconfig.json'];

const rootTsconfig = readTsconfig('tsconfig.json');
const buildTsconfig = readTsconfig('tsconfig.build.json');
const testsTsconfig = readTsconfig('tsconfig.tests.json');
const buildProjects = (buildTsconfig.references ?? []).map((reference) => reference.path);
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

  it.each(manifests)('%s: включён в сборку', (dir) => {
    expect(buildProjects).toContain(`packages/${dir}`);
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

describe('сборка не тянет тестовый код', () => {
  // Тесты входили в проект своего пакета, и `tsc --build` укладывал их
  // скомпилированные копии в `dist` рядом с приложением. В артефакте им делать
  // нечего: под vitest они читаются из исходников, а в production не вызываются.
  it.each(buildProjects)('%s: исключает проверки из сборки', (project) => {
    const config = readTsconfig(...configPathOf(project));
    expect(config.exclude ?? []).toContain('src/**/*.test.ts');
  });

  it.each(buildProjects)('%s: кэш сборки лежит внутри dist', (project) => {
    // Кэш рядом с настройкой переживает удаление `dist`, и следующая сборка
    // считает себя свежей: каталога нет, а собирать «нечего».
    const config = readTsconfig(...configPathOf(project));
    expect(config.compilerOptions?.['tsBuildInfoFile']).toBe('dist/tsconfig.tsbuildinfo');
  });

  it('списки проектов не разъезжаются', () => {
    // Два корневых файла ссылаются на одни и те же проекты, и разъезжаются они молча:
    // забытый в сборке пакет продолжает появляться в `dist` (его собирает шаг «Типы»),
    // а `pnpm build` его уже не собирает. Гейт такого не заметит — он `pnpm build`
    // не запускает вовсе.
    //
    // Проверочный проект отличается от собираемого не именем, а тем, что ничего
    // не порождает. Поэтому список здесь не задан, а выведен.
    const emitting = (rootTsconfig.references ?? [])
      .map((reference) => reference.path)
      .filter(
        (project) => readTsconfig(...configPathOf(project)).compilerOptions?.['noEmit'] !== true,
      );
    expect([...emitting].sort()).toEqual([...buildProjects].sort());
  });

  it('проект проверки тестов ничего не порождает', () => {
    // Иначе тесты вернулись бы в артефакт другой дорогой.
    expect(testsTsconfig.compilerOptions?.['noEmit']).toBe(true);
  });
});
