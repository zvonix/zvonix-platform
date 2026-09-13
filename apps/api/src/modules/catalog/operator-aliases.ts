/**
 * Замер написаний операторов: что говорит план нумерации и что отвечает внешний сервис.
 *
 * `pnpm operators:aliases [сколько номеров на оператора]`
 *
 * Задача одна, и она денежная. План нумерации называет юридическое лицо —
 * `ООО "Скартел"`. Внешний сервис на номере из того же диапазона отвечает `Йота`.
 * Это одно и то же лицо под двумя разными словами, и приведение написаний такое
 * не сводит: они различаются не окончанием, а составом. Пока написание не связано
 * с оператором, резолвер пишет «оператор из ответа источника не найден в справочнике»,
 * и **вызовы на эти номера не совершаются вовсе**.
 *
 * Найти такие пары иначе нельзя: узнать, как источник называет оператора, можно только
 * спросив его про номер этого оператора. Отсюда и способ — выборка номеров из диапазонов
 * каждого импортированного оператора.
 *
 * Команда ничего не меняет. Связь «написание → оператор» задаёт человек
 * (`POST /operators/:id/aliases`): выборка может попасть на **перенесённый** номер,
 * и тогда чужое название закрепилось бы за оператором навсегда. Отчёт показывает,
 * сколько ответов совпало, — по этому и видно, синоним это или перенос.
 */

import 'reflect-metadata';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Msisdn } from '@zvonix/shared';
import { AppModule } from '../../app.module.js';
import { DatabaseService } from '../../infra/database.service.js';
import { OperatorResolverService } from './operator-resolver.service.js';

/**
 * Сколько номеров спрашивается на оператора.
 *
 * Три — потому что один ответ не отличает синоним от переноса. Совпали все три —
 * это написание; ответил иначе один из трёх — скорее всего перенесённый номер.
 */
const DEFAULT_SAMPLES = 3;

/** Предел на всякий случай: источник держит два запроса в секунду на всю платформу. */
const MAX_SAMPLES = 10;

interface Sample {
  readonly operatorId: string;
  readonly operatorName: string;
  readonly msisdn: Msisdn;
}

interface Finding {
  readonly planName: string;
  /** Что ответил источник и сколько раз. */
  readonly answers: Map<string, number>;
  readonly known: number;
  readonly unknown: number;
}

/**
 * Номера для опроса: из середины самых крупных диапазонов оператора.
 *
 * Из середины, а не с края: начало диапазона часто зарезервировано и абонентов там нет.
 * Из крупных — там больше шансов попасть на живого абонента, а мёртвый номер источник
 * не опознаёт и ответа не даёт.
 */
async function collectSamples(database: DatabaseService, perOperator: number): Promise<Sample[]> {
  const result = await database.db.execute(sql`
    select "operatorId", "operatorName", msisdn from (
      -- Имена колонок в кавычках: сырой запрос отдаёт их как есть, и нижнее
      -- подчёркивание здесь молча дало бы пустое поле в каждой строке.
      select o.id as "operatorId",
             o.name as "operatorName",
             (r.range_start + (r.range_end - r.range_start) / 2)::text as "msisdn",
             row_number() over (
               partition by r.operator_id order by (r.range_end - r.range_start) desc
             ) as rank
        from numbering_plan_ranges r
        join operators o on o.id = r.operator_id
    ) ranked
    where rank <= ${perOperator}
    order by "operatorName", "msisdn"
  `);
  return result.rows as unknown as Sample[];
}

function shareOf(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)} %`;
}

/**
 * Названия, встретившиеся у **нескольких** операторов плана.
 *
 * Это ключ ко всему отчёту. Источник на номере MVNO отвечает именем **хозяина сети**,
 * а не самого MVNO: `ООО "БЕЗЛИМИТ"` отдаёт `Билайн`, и `ООО "СПРИНТ"` тоже. Связать
 * `Билайн` с одним из них значило бы, что все номера Билайна определяются как этот
 * оператор. Такое название — сеть, а не написание, и синонимом оно быть не может.
 */
function networkNames(findings: Map<string, Finding>): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const [operatorId, finding] of findings) {
    for (const answer of finding.answers.keys()) {
      const set = owners.get(answer) ?? new Set<string>();
      set.add(operatorId);
      owners.set(answer, set);
    }
  }

  const shared = new Set<string>();
  for (const [answer, ids] of owners) if (ids.size > 1) shared.add(answer);
  return shared;
}

function report(findings: Map<string, Finding>, asked: number, elapsedMs: number): string {
  const lines: string[] = [];
  const add = (line = ''): number => lines.push(line);

  const networks = networkNames(findings);
  const needAlias = [...findings.values()].filter((finding) => finding.unknown > 0);

  add();
  add('=== Написания операторов ===');
  add(`  опрошено номеров:       ${String(asked)}`);
  add(`  операторов в плане:     ${String(findings.size)}`);
  add(`  требуют синонима:       ${String(needAlias.length)}`);
  add(`  заняло:                 ${(elapsedMs / 1000).toFixed(0)} с`);

  if (needAlias.length === 0) {
    add();
    add('  Все написания источника уже связаны с операторами справочника.');
    return lines.join('\n');
  }

  add();
  add('  Оператор из плана нумерации → как его называет источник');
  add();

  for (const finding of needAlias.sort((a, b) => b.unknown - a.unknown)) {
    add(`  ${finding.planName}`);
    for (const [answer, count] of [...finding.answers].sort((a, b) => b[1] - a[1])) {
      const mark = networks.has(answer)
        ? '  ← сеть, а не синоним: тот же ответ у других операторов'
        : '';
      add(`      ${answer.padEnd(40)} ×${String(count)}${mark}`);
    }
    add(
      `      не опознано справочником: ${String(finding.unknown)} из ${String(finding.known + finding.unknown)}`,
    );
    add();
  }

  add('  Что делать: связать написание с оператором — POST /operators/:id/aliases.');
  add('  Не связывать помеченное «сеть, а не синоним»: источник отвечает так на номерах');
  add('  MVNO, называя хозяина сети. Синоним из этого сделал бы всю сеть одним MVNO.');
  add('  Осторожно и с одиночными ответами: это может быть перенесённый номер,');
  add('  и тогда чужое название закрепится за оператором навсегда.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? DEFAULT_SAMPLES);
  const perOperator = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SAMPLES)
    : DEFAULT_SAMPLES;

  let app;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
  } catch (cause) {
    process.stderr.write(`Не удалось поднять приложение: ${String(cause)}\n`);
    process.exitCode = 1;
    return;
  }

  const database = app.get(DatabaseService);
  const resolver = app.get(OperatorResolverService);

  try {
    const samples = await collectSamples(database, perOperator);
    if (samples.length === 0) {
      process.stderr.write(
        'План нумерации пуст: загрузить его командой pnpm numbering-plan:load\n' +
          '(либо дождаться прохода воркера numbering-plan.refresh).\n',
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `Опрашиваю ${String(samples.length)} номеров, по ${String(perOperator)} на оператора.\n` +
        'Источник держит два запроса в секунду, так что это займёт минуты.\n',
    );

    const findings = new Map<string, Finding>();
    const startedAt = Date.now();

    for (const sample of samples) {
      const finding = findings.get(sample.operatorId) ?? {
        planName: sample.operatorName,
        answers: new Map<string, number>(),
        known: 0,
        unknown: 0,
      };

      const resolution = await resolver.resolve(sample.msisdn);
      const unknown = resolution.unknownOperatorNames ?? [];

      if (unknown.length > 0) {
        for (const name of unknown) finding.answers.set(name, (finding.answers.get(name) ?? 0) + 1);
        findings.set(sample.operatorId, { ...finding, unknown: finding.unknown + 1 });
        continue;
      }

      if (resolution.serving !== undefined) {
        const name = resolution.serving.name;
        finding.answers.set(name, (finding.answers.get(name) ?? 0) + 1);
      }
      findings.set(sample.operatorId, { ...finding, known: finding.known + 1 });
    }

    process.stdout.write(report(findings, samples.length, Date.now() - startedAt));
    process.stdout.write('\n');
    process.stdout.write(
      `Опознано справочником: ${shareOf(
        [...findings.values()].reduce((sum, finding) => sum + finding.known, 0),
        samples.length,
      )}\n`,
    );
  } finally {
    await app.close();
  }
}

await main();
