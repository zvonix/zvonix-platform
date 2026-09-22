/**
 * Пакетное разрешение номеров и замер доли перенесённых.
 *
 * `pnpm numbers:resolve <файл> [отчёт.csv]`
 *
 * Отвечает на вопрос, от которого зависит вся модель: **какая доля номеров реально
 * перенесена к другому оператору**. Если она мала, план нумерации почти всегда даёт
 * верный ответ и внешний сервис нужен изредка. Если велика — определение оператора
 * держится на источнике целиком, и запасной поставщик становится обязательным.
 * До замера это неизвестно, а решения на догадках здесь стоят денег партнёров.
 *
 * Отдельная команда, а не обработчик HTTP: сто тысяч номеров при вежливых двух запросах
 * в секунду разрешаются около четырнадцати часов, и держать ради этого HTTP-соединение
 * бессмысленно. Когда появится `apps/worker`, та же служба вызовется оттуда — здесь
 * нет ничего, что пришлось бы переписывать.
 *
 * Каждый ответ сохраняется в собственную базу, поэтому повторный запуск на том же
 * списке наружу почти не ходит: это не только замер, но и наполнение базы.
 */

import 'reflect-metadata';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { normalizeMsisdn, type Msisdn } from '@zvonix/shared';
import { AppModule } from '../../app.module.js';
import { OperatorResolverService, type OperatorResolution } from './operator-resolver.service.js';

/** Как часто печатать ход работы. Прогон идёт часами, и молчащая команда неотличима от зависшей. */
const PROGRESS_EVERY = 100;

interface Tally {
  total: number;
  invalid: number;
  unique: number;
  /** Сколько номеров источник вообще опознал — знаменатель доли перенесённых. */
  answered: number;
  confirmed: number;
  ported: number;
  unconfirmed: number;
  byOperator: Map<string, number>;
  byReason: Map<string, number>;
  unknownNames: Map<string, number>;
}

function emptyTally(): Tally {
  return {
    total: 0,
    invalid: 0,
    unique: 0,
    answered: 0,
    confirmed: 0,
    ported: 0,
    unconfirmed: 0,
    byOperator: new Map(),
    byReason: new Map(),
    unknownNames: new Map(),
  };
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Читает номера построчно, а не файлом целиком: выгрузка абонентской базы
 * бывает на сотни мегабайт, и загонять её в память незачем.
 *
 * Из строки берётся первое поле — так подходит и «номер на строку», и выгрузка CSV,
 * где номер стоит первой колонкой.
 */
async function* readNumbers(file: string): AsyncGenerator<string> {
  const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of stream) {
    const cell = line.split(/[;,\t]/)[0]?.trim() ?? '';
    if (cell !== '') yield cell;
  }
}

function describe(resolution: OperatorResolution, tally: Tally): string {
  // Пробелы справочника считаем в обоих случаях: и когда не опознан обслуживающий
  // оператор, и когда не опознан прежний — второе тихо занижает долю перенесённых.
  for (const name of resolution.unknownOperatorNames ?? []) bump(tally.unknownNames, name);

  // Перенос считаем по ответу источника, а не по нашему справочнику: иначе доля
  // занижается ровно там, где справочник неполон, и замер врёт тем сильнее,
  // чем хуже данные.
  if (resolution.portedBySource === true) tally.ported += 1;
  if (resolution.portedBySource !== undefined) tally.answered += 1;

  if (resolution.confirmed && resolution.serving !== undefined) {
    tally.confirmed += 1;
    bump(tally.byOperator, resolution.serving.name);
    return resolution.serving.name;
  }

  tally.unconfirmed += 1;
  bump(tally.byReason, resolution.reason ?? 'unknown');
  return '';
}

function share(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)} %`;
}

function report(tally: Tally, elapsedMs: number): string {
  const lines: string[] = [];
  const add = (line = ''): number => lines.push(line);

  add();
  add('=== Итог замера ===');
  add(`  строк в файле:          ${String(tally.total)}`);
  add(`  не похоже на номер:     ${String(tally.invalid)}`);
  add(`  уникальных номеров:     ${String(tally.unique)}`);
  add(
    `  оператор подтверждён:   ${String(tally.confirmed)}  (${share(tally.confirmed, tally.unique)})`,
  );
  add(
    `  не подтверждён:         ${String(tally.unconfirmed)}  (${share(tally.unconfirmed, tally.unique)})`,
  );
  add();
  add('  ГЛАВНОЕ ЧИСЛО');
  add(
    `  перенесённых номеров:   ${String(tally.ported)} из ${String(tally.answered)} опознанных источником — ${share(tally.ported, tally.answered)}`,
  );
  add('  Это доля, на которой план нумерации отвечает неверно.');
  add('  Считается по ответу источника и не зависит от полноты нашего справочника.');

  if (tally.byOperator.size > 0) {
    add();
    add('  По операторам:');
    for (const [name, count] of [...tally.byOperator].sort((a, b) => b[1] - a[1])) {
      add(`    ${name.padEnd(32)} ${String(count).padStart(7)}  ${share(count, tally.confirmed)}`);
    }
  }

  if (tally.byReason.size > 0) {
    add();
    add('  Почему не подтверждён:');
    for (const [reason, count] of [...tally.byReason].sort((a, b) => b[1] - a[1])) {
      add(`    ${reason.padEnd(32)} ${String(count).padStart(7)}`);
    }
  }

  if (tally.unknownNames.size > 0) {
    add();
    add('  ПРОБЕЛЫ В СПРАВОЧНИКЕ — эти написания надо добавить администратору:');
    for (const [name, count] of [...tally.unknownNames].sort((a, b) => b[1] - a[1])) {
      add(`    ${name.padEnd(32)} ${String(count).padStart(7)} номеров`);
    }
  }

  add();
  add(`  затрачено: ${(elapsedMs / 1000).toFixed(0)} с`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [, , input, output] = process.argv;
  if (input === undefined) {
    process.stderr.write(
      'Использование: pnpm numbers:resolve <файл со списком номеров> [отчёт.csv]\n' +
        'Номер берётся из первого поля строки, поэтому годится и простой список,\n' +
        'и выгрузка CSV. Повторы отбрасываются.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Подъём приложения — внутри перехвата: неверная конфигурация обрывает старт
  // раньше любой работы, и без сообщения команда просто молча возвращает единицу.
  // `abortOnError: false` здесь обязателен — иначе NestJS завершает процесс сам,
  // до нашего обработчика, и причина не печатается вовсе.
  let app;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
  } catch (cause) {
    process.stderr.write(`Не удалось поднять приложение: ${String(cause)}
`);
    process.exitCode = 1;
    return;
  }
  const resolver = app.get(OperatorResolverService);

  const tally = emptyTally();
  const seen = new Set<Msisdn>();
  const rows: string[] = [
    'msisdn;operator;previous_operator;region;source;confirmed;ported;reason;unknown_operator',
  ];
  const startedAt = Date.now();

  try {
    for await (const raw of readNumbers(path.resolve(input))) {
      tally.total += 1;

      const msisdn = normalizeMsisdn(raw);
      if (msisdn === undefined) {
        tally.invalid += 1;
        continue;
      }
      // Повторы не стоят ни запроса, ни времени: платформа платит за различные
      // номера, а не за число звонков по ним.
      if (seen.has(msisdn)) continue;
      seen.add(msisdn);
      tally.unique += 1;

      const resolution = await resolver.resolve(msisdn);
      const operator = describe(resolution, tally);

      rows.push(
        [
          msisdn,
          operator,
          resolution.previousOperator?.name ?? '',
          resolution.region ?? '',
          resolution.source ?? '',
          String(resolution.confirmed),
          resolution.portedBySource === true ? 'да' : '',
          resolution.reason ?? '',
          (resolution.unknownOperatorNames ?? []).join('|'),
        ].join(';'),
      );

      if (tally.unique % PROGRESS_EVERY === 0) {
        const rate = tally.unique / ((Date.now() - startedAt) / 1000);
        process.stdout.write(
          `  разрешено ${String(tally.unique)}, перенесённых ${String(tally.ported)}, ` +
            `темп ${rate.toFixed(1)}/с\n`,
        );
      }
    }

    process.stdout.write(report(tally, Date.now() - startedAt) + '\n');

    if (output !== undefined) {
      // Разделитель `;` и BOM — чтобы Excel открыл файл с кириллицей без плясок.
      await writeFile(path.resolve(output), '﻿' + rows.join('\n') + '\n', 'utf8');
      process.stdout.write(`\n  подробности: ${path.resolve(output)}\n`);
    }
  } catch (cause) {
    process.stderr.write(`Разрешение прервано: ${String(cause)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
