/**
 * Какой выпуск работает на сервере.
 *
 * Архив выпуска несёт в корне файл `RELEASE` (`scripts/release-pack.mjs`): метка, коммит
 * и время сборки. Отдельной переменной окружения для версии нет намеренно — окружение
 * выкладкой не переписывается ([ADR-0049](../../../../docs/adr/0049-vykladka-ploshchadki.md)),
 * и версия в нём отставала бы от выложенного кода. Файл едет в том же архиве, что и код,
 * и разойтись с ним не может.
 *
 * Вне выпуска — в разработке и тестах — файла нет, и версия неизвестна (`null`), а не
 * выдумана: «dev» в кабинете читался бы как название выпуска.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ReleaseInfo {
  /** Метка выпуска, например `v0.1.3`. */
  readonly version: string | null;
  readonly commit: string | null;
  /** Время сборки архива, ISO 8601. */
  readonly builtAt: string | null;
}

const UNKNOWN: ReleaseInfo = { version: null, commit: null, builtAt: null };

/**
 * Корень выпуска — четыре каталога вверх от этого файла: `apps/api/dist/infra/release.js`
 * в выпуске, `apps/api/src/infra/release.ts` в тестах. Через `fileURLToPath`, а не
 * `.pathname`: иначе кириллица в пути к репозиторию превращается в проценты (правило 5).
 */
const RELEASE_FILE = fileURLToPath(new URL('../../../../RELEASE', import.meta.url));

/** Разбор `RELEASE`: первая строка — метка, дальше строки `commit …` и `built …`. */
export function parseRelease(text: string): ReleaseInfo {
  const [first = '', ...rest] = text.split('\n').map((line) => line.trim());
  const field = (name: string): string | null => {
    const line = rest.find((candidate) => candidate.startsWith(`${name} `));
    const value = line?.slice(name.length + 1).trim();
    return value === undefined || value === '' ? null : value;
  };
  return {
    version: first === '' ? null : first,
    commit: field('commit'),
    builtAt: field('built'),
  };
}

/** Читается один раз при старте: выпуск под работающим процессом не меняется. */
export function readRelease(file: string = RELEASE_FILE): ReleaseInfo {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // Нет файла — это сборка не из выпуска, а не сбой. Любая другая ошибка чтения
    // (права, диск) — сбой, и молча превращать его в «версия неизвестна» нельзя.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return UNKNOWN;
    throw error;
  }
  return parseRelease(text);
}
