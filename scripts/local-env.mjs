/**
 * Локальные настройки проверки — файл `.env.verify.local` в корне, вне git (правило `.env.*` в `.gitignore`).
 *
 * Нужен машине, где обычные адреса не подходят: на этой, например, порт 5432 занят чужим PostgreSQL, а база проекта
 * живёт на 5433. Без файла приходилось задавать `TEST_DATABASE_URL` в каждом новом окне терминала.
 *
 * Строки `ИМЯ=значение`, пустые и начинающиеся с `#` пропускаются. Что уже задано в окружении, файлом не перекрывается.
 * Подключается первой строкой скриптов, которые читают адреса при загрузке (`import './local-env.mjs'`).
 *
 * Кроме адресов, в файле можно дать команды запуска служб, которые не переживают перезагрузку:
 * `VERIFY_START_POSTGRES=…` и `VERIFY_START_REDIS=…` — `pnpm verify` выполнит их сам, если служба не отвечает.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.verify.local');

if (existsSync(FILE)) {
  for (const raw of readFileSync(FILE, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1);
    process.env[name] ??= value;
  }
}
