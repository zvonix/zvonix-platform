/**
 * Тесты с базой для гейта: `pnpm test:integration` плюс повтор **потерянных файлов**.
 *
 * Зачем. В Windows рабочий процесс vitest примерно в половине прогонов гибнет посреди файла: `Worker exited
 * unexpectedly`, ни одного упавшего утверждения (разбор и исключённые причины — в `vitest.integration.config.ts`). Файл
 * при этом не выполнен целиком, и красный шаг означал «потерян процесс», а не «сломан код». Читать такой красный как
 * сломанный — приучить не верить гейту; считать его зелёным — пропустить непроверенное.
 *
 * Что делает. Запускает набор с отчётом JSON, сверяет файлы набора с файлами, у которых есть результат, и **только
 * не выполненные** прогоняет заново (до двух раз). Упавшее утверждение повтором не лечится: любой файл с упавшим тестом
 * — красный сразу, как и раньше. Каждый повтор и его причина печатаются, а итог говорит, что теряли и чем кончилось.
 *
 * Параметры vitest (например, путь к файлу) передаются как есть и повтора не включают: это ручной запуск.
 */

import './local-env.mjs';
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = '{apps,packages}/*/src/**/*.integration.test.ts';
const MAX_RETRIES = 2;

function expectedFiles() {
  return globSync(PATTERN, {
    cwd: ROOT,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  })
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/** Один запуск vitest; возвращает код, файлы с результатом и число упавших утверждений. */
function run(files, reportFile) {
  const args = [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportFile}`,
    ...files,
  ];
  const result = spawnSync('pnpm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  let finished = new Set();
  let failed = 0;
  try {
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    // Файл выполнен, если у него есть упавшее утверждение (это отказ, а не потеря) или все утверждения дошли до конца.
    // Погибший посреди файла процесс vitest записывает как «passed» с утверждениями в состоянии «pending» — поэтому
    // судить по статусу файла нельзя. Пропущенных тестов (`skip`, `todo`) в интеграционных файлах нет: vitest
    // отмечает их тем же «pending», и появись они, этот скрипт считал бы файл потерянным, а не пропущенным.
    finished = new Set(
      report.testResults
        .filter(
          (entry) =>
            entry.assertionResults.some((assertion) => assertion.status === 'failed') ||
            (entry.status === 'passed' &&
              entry.assertionResults.every((assertion) => assertion.status === 'passed')),
        )
        .map((entry) => path.relative(ROOT, entry.name).split(path.sep).join('/')),
    );
    failed = report.numFailedTests;
  } catch {
    // Отчёта нет — процесс vitest не дошёл до записи; все файлы считаются не выполненными.
  }
  return { code: result.status ?? 1, finished, failed };
}

function main() {
  const passthrough = process.argv.slice(2);
  const dir = mkdtempSync(path.join(tmpdir(), 'zvonix-integration-'));
  const report = path.join(dir, 'report.json');
  try {
    // С явными файлами или флагами — обычный ручной запуск без повторов.
    if (passthrough.length > 0) return run(passthrough, report).code;

    const expected = expectedFiles();
    let pending = expected;
    const lost = [];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const outcome = run(pending, report);
      if (outcome.failed > 0) {
        console.error(
          `\nУпали утверждения: ${String(outcome.failed)}. Повтор не применяется — это не потеря процесса.`,
        );
        return 1;
      }
      const missing = pending.filter((file) => !outcome.finished.has(file));
      if (missing.length === 0) {
        if (outcome.code !== 0) return outcome.code;
        if (lost.length > 0) {
          console.log(
            `\nПотеря рабочего процесса vitest (известная особенность Windows), повторено файлов: ${String(lost.length)}:`,
          );
          for (const file of lost) console.log(`  - ${file}`);
          console.log('Все файлы набора выполнены, упавших утверждений нет.');
        }
        return 0;
      }
      lost.push(...missing.filter((file) => !lost.includes(file)));
      if (attempt === MAX_RETRIES) {
        console.error(
          `\nНе выполнены после ${String(MAX_RETRIES)} повторов: ${missing.join(', ')}`,
        );
        return 1;
      }
      console.log(
        `\nПотерян рабочий процесс vitest: не выполнено файлов — ${String(missing.length)}. Повтор ${String(attempt + 1)} из ${String(MAX_RETRIES)}:`,
      );
      for (const file of missing) console.log(`  - ${file}`);
      pending = missing;
    }
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
