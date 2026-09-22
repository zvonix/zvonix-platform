/**
 * Проверка внутренних ссылок в документации.
 *
 * Зачем отдельный шаг: документация в этом проекте — основной носитель контекста между
 * сессиями (правило 8 в CLAUDE.md). Ссылка, ведущая в никуда, означает потерянное
 * обоснование: файл переименовали, а десяток ADR продолжает на него ссылаться,
 * и узнаётся это ровно тогда, когда обоснование понадобилось.
 *
 * Проверяется и **регистр имени**, а не только существование файла. Разработка идёт
 * в Windows, где `fs.existsSync` регистронезависим, а прод и CI — Ubuntu, где нет.
 * Ссылка `docs/Architecture.md` на файл `docs/ARCHITECTURE.md` локально проходит
 * и падает только на Ubuntu — тот самый класс расхождений, ради которого правило 5
 * CLAUDE.md требует писать под Linux.
 *
 * Не проверяется: внешние адреса (сеть в гейте не нужна) и якоря внутри файлов
 * (правила построения якоря из кириллического заголовка различаются у отображающих
 * средств, и проверка давала бы ложные срабатывания).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

/** Ссылка вида `[текст](цель)`. Ссылки-сноски в проекте не используются. */
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Внешние схемы и якорь в пределах файла — не наше дело. */
const EXTERNAL = /^(https?:|mailto:|tel:|#)/;

function markdownFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/**
 * Существует ли путь с точностью до регистра.
 *
 * `existsSync` в Windows ответит «да» на `ARCHITECTURE.md`, `architecture.md`
 * и `Architecture.md` одинаково, поэтому имя дополнительно ищется в списке каталога.
 */
function existsExactly(target) {
  if (!existsSync(target)) return false;
  let current = target;
  while (current !== ROOT && current.startsWith(ROOT)) {
    const parent = path.dirname(current);
    if (!readdirSync(parent).includes(path.basename(current))) return false;
    current = parent;
  }
  return true;
}

const problems = [];
let checked = 0;

for (const file of markdownFiles(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      const raw = match[1];
      if (raw === undefined || EXTERNAL.test(raw)) continue;

      checked += 1;
      // Отбрасываем якорь: цель проверяется как файл или каталог.
      const relative = decodeURIComponent(raw.split('#')[0] ?? '');
      if (relative === '') continue;

      const target = path.resolve(path.dirname(file), relative);
      // Разделитель приводится к косой черте: иначе вывод в Windows и в CI на Ubuntu
      // различается, и одна и та же проблема выглядит двумя разными.
      const where = `${path.relative(ROOT, file).split(path.sep).join('/')}:${index + 1}`;

      if (!existsSync(target)) {
        problems.push(`${where}  ->  ${raw}  (цели нет)`);
      } else if (!existsExactly(target)) {
        problems.push(`${where}  ->  ${raw}  (не совпадает регистр — упадёт на Ubuntu)`);
      } else if (relative.endsWith('/') && !statSync(target).isDirectory()) {
        problems.push(`${where}  ->  ${raw}  (ссылка на каталог, а цель — файл)`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`Битых ссылок в документации: ${problems.length}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Внутренних ссылок проверено: ${checked}. Битых нет.`);
