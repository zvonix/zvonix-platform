/**
 * Архив выпуска площадки ([ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md)).
 *
 * Берёт уже собранный репозиторий (`pnpm build`, `pnpm web:build`) и раскладывает в каталог
 * выпуска только то, что нужно для запуска, в раскладке репозитория. Зависимостей API
 * и воркера в архиве нет: их ставит сервер под свою систему (`@node-rs/argon2` нативный).
 * Кабинет везёт свои — их отобрал Next в самодостаточной сборке.
 *
 * Запуск: `node scripts/release-pack.mjs <метка> [каталог]`.
 * Результат: `<каталог>/zvonix-<метка>.tgz` и `.sha256` в формате `sha256sum -c`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function fail(message) {
  console.error(`Архив выпуска не собран: ${message}`);
  process.exit(1);
}

const [tag, outDirectory = 'release'] = process.argv.slice(2);
// Метка попадает в имя файла, в адрес выпуска и в команду на сервере: только безопасные знаки.
if (tag === undefined || !/^v?[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(tag)) {
  fail('укажите метку выпуска, например v0.1.0');
}

const OUT = path.resolve(ROOT, outDirectory);
const NAME = `zvonix-${tag}`;
const STAGE = path.join(OUT, NAME);

/**
 * Рабочие пространства. Список групп сверяется с `pnpm-workspace.yaml`: заведут третью
 * группу — архив откажется собираться, а не выйдет без её манифестов, с которыми
 * `pnpm install --frozen-lockfile` на сервере не сходится с lock-файлом.
 */
const GROUPS = ['apps', 'packages'];
const workspaceFile = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const declared = [...workspaceFile.matchAll(/^\s*-\s*'([^']+)'/gmu)].map((match) => match[1]);
if (declared.join(',') !== GROUPS.map((group) => `${group}/*`).join(',')) {
  fail(`pnpm-workspace.yaml объявляет ${declared.join(', ')} — обновите GROUPS в этом скрипте`);
}

const workspaces = GROUPS.flatMap((group) =>
  readdirSync(path.join(ROOT, group), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(ROOT, group, entry.name, 'package.json')),
    )
    .map((entry) => `${group}/${entry.name}`),
);

/** Что запускается на сервере из `dist`: все пакеты и два приложения. Кабинет — отдельно. */
const RUNTIME = workspaces.filter((workspace) => workspace !== 'apps/web');

function copy(from, to = from) {
  const source = path.join(ROOT, from);
  if (!existsSync(source)) fail(`нет ${from} — соберите проект перед упаковкой`);
  cpSync(source, path.join(STAGE, to), {
    recursive: true,
    // pnpm раскладывает зависимости ссылками. Разыменованные, они размножили бы архив.
    verbatimSymlinks: true,
    // Кэш инкрементальной сборки на сервере не нужен.
    filter: (file) => !file.endsWith('.tsbuildinfo'),
  });
}

function commit() {
  if (process.env['GITHUB_SHA'] !== undefined) return process.env['GITHUB_SHA'];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'неизвестен';
  }
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) copy(file);
// Манифесты всех пространств, включая кабинет: без них lock-файл не сходится.
for (const workspace of workspaces) copy(`${workspace}/package.json`);
for (const workspace of RUNTIME) copy(`${workspace}/dist`);
copy('packages/db/migrations');
// `GET /install.sh` читает установщик узла и шаблоны из `node/` во время работы.
copy('node');
copy('deploy');

// Самодостаточная сборка Next не содержит статики — её кладут рядом с `server.js`.
const STANDALONE = 'apps/web/.next/standalone';
if (!existsSync(path.join(ROOT, STANDALONE, 'apps/web/server.js'))) {
  fail(`нет ${STANDALONE}/apps/web/server.js — нужен pnpm web:build с output: 'standalone'`);
}
copy(STANDALONE);
copy('apps/web/.next/static', `${STANDALONE}/apps/web/.next/static`);
if (existsSync(path.join(ROOT, 'apps/web/public'))) {
  copy('apps/web/public', `${STANDALONE}/apps/web/public`);
}

writeFileSync(
  path.join(STAGE, 'RELEASE'),
  `${tag}\ncommit ${commit()}\nbuilt ${new Date().toISOString()}\n`,
);

execFileSync('tar', ['-czf', `${NAME}.tgz`, NAME], { cwd: OUT, stdio: 'inherit' });
rmSync(STAGE, { recursive: true, force: true });

const archive = path.join(OUT, `${NAME}.tgz`);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${NAME}.tgz\n`);

console.log(`Архив выпуска: ${path.relative(ROOT, archive)} (sha256 ${digest})`);
