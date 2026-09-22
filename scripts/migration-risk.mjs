/**
 * Разбор миграций выпуска: что в них может стоить данных или простоя.
 *
 *   node scripts/migration-risk.mjs [база]
 *
 * `база` — коммит или метка, с которой сравнивается `HEAD`: то, что уже стоит
 * на сервере (его коммит — во второй строке `/opt/zvonix/current/RELEASE`).
 * Без аргумента — последняя метка `v*`, а если выпусков не было — все миграции.
 *
 * Выкладка применяет миграции сама и без вопросов ([deploy/deploy.sh](../deploy/deploy.sh)),
 * а откат выпуска их не отменяет ([ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md)).
 * Поэтому решение принимается до метки, и принимает его человек: скрипт только
 * находит строки, о которых надо спросить. Правила — [ADR-0005](../docs/adr/0005-migracii.md):
 * разрушающее изменение делается в два шага, применённая миграция не правится.
 *
 * Операция над таблицей, созданной в той же миграции, не опасна: таблица пуста
 * и старым кодом не читается. Всё остальное — кандидат, а не приговор: расширение
 * набора значений в `CHECK` безопасно, сужение — нет, и различает их только чтение.
 *
 * Код возврата: 0 — находок нет, 1 — есть находки, 2 — не удалось разобрать вход.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = 'packages/db/migrations';

/** Вес находки — от «теряет данные» до «запирает таблицу». */
const LOSS = 'теряет данные';
const MAY_FAIL = 'может не накатиться на живые данные';
const BREAKS_OLD = 'ломает работающий выпуск';
const LOCKS = 'запирает таблицу на время';
const CHANGES = 'меняет данные';

/**
 * Правила: образец оператора и что он значит. Первая скобка образца — имя таблицы:
 * по нему находка снимается, если таблица создана этой же миграцией.
 */
const RULES = [
  {
    pattern: /^DROP TABLE\s+(?:IF EXISTS\s+)?"([^"]+)"/iu,
    weight: LOSS,
    why: 'таблица удаляется вместе с данными',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+DROP COLUMN/iu,
    weight: LOSS,
    why: 'колонка удаляется, а работающий выпуск её ещё читает — нужны два шага',
  },
  { pattern: /^TRUNCATE\s+(?:TABLE\s+)?"([^"]+)"/iu, weight: LOSS, why: 'таблица очищается' },
  {
    pattern: /^DELETE FROM\s+"([^"]+)"/iu,
    weight: LOSS,
    why: 'строки удаляются — какие именно, видно только в условии',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+RENAME/iu,
    weight: BREAKS_OLD,
    why: 'переименование: работающий выпуск обращается по старому имени — нужны два шага',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+ALTER COLUMN\s+"[^"]+"\s+SET DATA TYPE/iu,
    weight: LOSS,
    why: 'смена типа переписывает таблицу; сужение теряет значения',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+ALTER COLUMN\s+"[^"]+"\s+SET NOT NULL/iu,
    weight: MAY_FAIL,
    why: 'не накатится, если в колонке уже есть пустые значения',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+ADD COLUMN\s+"[^"]+"[^;]*\bNOT NULL\b/iu,
    unless: /\bDEFAULT\b/iu,
    weight: MAY_FAIL,
    why: 'колонка NOT NULL без DEFAULT не добавится к непустой таблице',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+ADD CONSTRAINT\s+"([^"]+)"\s+CHECK/iu,
    weight: MAY_FAIL,
    why: 'не накатится, если строки не проходят новое условие',
    replaced: 'заменяет прежнее с тем же именем: не уже ли новый набор прежнего',
  },
  {
    pattern: /^ALTER TABLE\s+"([^"]+)"\s+ADD CONSTRAINT\s+"[^"]+"\s+(?:UNIQUE|FOREIGN KEY)/iu,
    weight: MAY_FAIL,
    why: 'не накатится, если данные уже нарушают ограничение',
  },
  {
    pattern: /^CREATE UNIQUE INDEX\s+(?:IF NOT EXISTS\s+)?"[^"]+"\s+ON\s+"([^"]+)"/iu,
    weight: MAY_FAIL,
    why: 'не создастся при повторах в данных и запирает запись в таблицу на время построения',
  },
  {
    pattern: /^CREATE INDEX\s+(?!CONCURRENTLY)(?:IF NOT EXISTS\s+)?"[^"]+"\s+ON\s+"([^"]+)"/iu,
    weight: LOCKS,
    why: 'запись в таблицу ждёт, пока строится индекс',
  },
  {
    pattern: /^UPDATE\s+"([^"]+)"/iu,
    weight: CHANGES,
    why: 'правка данных: проверить условие и объём',
  },
];

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Операторы файла с номером строки, где каждый начинается.
 *
 * Номер считается по смещению в исходном тексте, а не по кускам после разбиения:
 * разделитель `;\n` съедает перевод строки, и счёт по кускам уезжал на столько строк,
 * сколько операторов выше (замер на 0004: `DELETE` на 21-й строке назывался 16-й).
 */
function statements(sql) {
  const found = [];
  // drizzle-kit разделяет операторы меткой; рукописные миграции — точкой с запятой.
  const separator = /--> statement-breakpoint|;[ \t]*(?:\r?\n|$)/gu;
  let start = 0;
  const take = (end) => {
    const rows = sql.slice(start, end).split('\n');
    const code = (row) => row.trim() !== '' && !row.trim().startsWith('--');
    // Строка оператора, а не комментария над ним: у рукописных миграций пояснение
    // стоит прямо перед оператором и входит в тот же кусок.
    const first = rows.findIndex(code);
    if (first === -1) return;
    const text = rows.filter(code).join(' ').replace(/\s+/gu, ' ').trim();
    found.push({ line: sql.slice(0, start).split('\n').length + first, text });
  };
  for (const match of sql.matchAll(separator)) {
    take(match.index);
    start = match.index + match[0].length;
  }
  take(sql.length);
  return found;
}

function findings(sql) {
  const all = statements(sql);
  const created = new Set();
  const dropped = new Set();
  for (const { text } of all) {
    const table = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/iu.exec(text)?.[1];
    if (table !== undefined) created.add(table);
    const constraint = /^ALTER TABLE\s+"[^"]+"\s+DROP CONSTRAINT\s+"([^"]+)"/iu.exec(text)?.[1];
    if (constraint !== undefined) dropped.add(constraint);
  }
  const result = [];
  for (const { line, text } of all) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      const table = match?.[1];
      if (table === undefined || created.has(table)) continue;
      if (rule.unless?.test(text) === true) continue;
      const replaced = rule.replaced !== undefined && dropped.has(match?.[2] ?? '');
      const why = replaced ? `${rule.why}; ${rule.replaced}` : rule.why;
      result.push({ line, weight: rule.weight, why, text });
      break;
    }
  }
  return result;
}

function fail(message) {
  console.error(`migration-risk: ${message}`);
  process.exitCode = 2;
}

function main() {
  const argument = process.argv[2];
  const base = argument ?? git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  if (argument !== undefined && git(['rev-parse', '--verify', `${argument}^{commit}`]) === null) {
    fail(`«${argument}» — не коммит и не метка этого репозитория.`);
    return;
  }

  let added;
  if (base === null) {
    added = (git(['ls-files', `${MIGRATIONS}/*.sql`]) ?? '').split('\n').filter(Boolean);
    console.log(`Выпусков не было — разбираются все миграции: ${String(added.length)}.`);
  } else {
    const range = `${base}..HEAD`;
    // Правка уже применённой миграции — отдельная тревога: база на сервере её не перечитает,
    // и расхождение обнаружится только следующей миграцией (ADR-0005).
    const edited = (
      git(['diff', '--name-only', '--diff-filter=MDR', range, '--', `${MIGRATIONS}/*.sql`]) ?? ''
    )
      .split('\n')
      .filter(Boolean);
    for (const file of edited) {
      console.log(`ПРАВКА ПРИМЕНЁННОЙ: ${file} изменён или удалён после ${base} — так нельзя.`);
    }
    if (edited.length > 0) process.exitCode = 1;
    added = (
      git(['diff', '--name-only', '--diff-filter=A', range, '--', `${MIGRATIONS}/*.sql`]) ?? ''
    )
      .split('\n')
      .filter(Boolean);
    console.log(`Новых миграций после ${base}: ${String(added.length)}.`);
  }

  let total = 0;
  for (const file of added.sort()) {
    const found = findings(readFileSync(path.join(ROOT, file), 'utf8'));
    if (found.length === 0) continue;
    console.log('');
    console.log(path.basename(file));
    for (const { line, weight, why, text } of found) {
      total += 1;
      console.log(`  :${String(line)}  ${weight} — ${why}`);
      console.log(`      ${text.length > 150 ? `${text.slice(0, 149)}…` : text}`);
    }
  }

  console.log('');
  console.log(total === 0 ? 'Опасных операторов не найдено.' : `Находок: ${String(total)}.`);
  if (total > 0) process.exitCode = 1;
}

main();
