/**
 * У каждой настройки площадки есть русская подпись в кабинете.
 *
 * Настройка без подписи показывается сырым ключом — так `bot.block_stops_accounts` вышла к владельцу в «Настройках площадки»
 * (2026-10-22). Список настроек живёт в API, подписи — в кабинете, общего модуля у них нет, поэтому сверяются тексты
 * исходников: ключи объявлены строковыми литералами одного вида.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

/** Ключи вида `'раздел.имя': {` — объявления в `SETTINGS`. */
const settingKeys = (source: string): string[] =>
  [...source.matchAll(/^\s{2}'([a-z_]+\.[a-z_]+)':\s*\{/gmu)].map((match) => match[1] ?? '');

/** Тело объекта `LABELS` и ключи-литералы в нём. */
const labelKeys = (source: string): Set<string> => {
  const start = source.indexOf('const LABELS');
  const body = source.slice(start, source.indexOf('\n};', start));
  return new Set(
    [...body.matchAll(/^\s{2}'([a-z_]+\.[a-z_]+)':/gmu)].map((match) => match[1] ?? ''),
  );
};

describe('подписи настроек площадки', () => {
  it('у каждой настройки из API есть подпись в кабинете', () => {
    const keys = settingKeys(read('apps/api/src/modules/settings/settings.ts'));
    const labels = labelKeys(read('apps/web/src/app/settings/setting-field.tsx'));
    // Разбор не сломался молча: настроек десятки.
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((key) => !labels.has(key))).toEqual([]);
  });
});
