/**
 * Загрузка плана нумерации по требованию.
 *
 * `pnpm numbering-plan:load`
 *
 * То же, что делает фоновая задача `numbering-plan.refresh`
 * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)), но сейчас
 * и без оглядки на отметку последней загрузки. Нужна в двух случаях: развернули
 * площадку и не хотите ждать первого прохода воркера, либо источник обновил файл
 * и это надо забрать немедленно.
 *
 * Замена по-прежнему происходит только если набор правдоподобен: неудачная загрузка
 * не стирает уже загруженный план.
 */

import 'reflect-metadata';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { NumberingPlanService } from './numbering-plan.service.js';

async function main(): Promise<void> {
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

  try {
    const result = await app.get(NumberingPlanService).load(new Date());
    if (result === undefined) {
      // Причина уже в логе: источник недоступен либо набор негоден. Прежний план цел.
      process.stderr.write('План нумерации не загружен — прежний остался на месте.\n');
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `Загружено диапазонов: ${String(result.ranges)}\n` +
        `Отброшено строк:      ${String(result.skipped)}\n` +
        `Заведено операторов:  ${String(result.operatorsCreated)}\n`,
    );
  } finally {
    await app.close();
  }
}

await main();
