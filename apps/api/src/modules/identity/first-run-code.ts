/**
 * Код первого запуска: `node dist/modules/identity/first-run-code.js`
 * ([ADR-0050](../../../../../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).
 *
 * Печатает код, по которому кабинет заведёт первого администратора, — только пока
 * администратора нет. Зовёт её выкладка (`deploy/deploy.sh`) после перехода на выпуск;
 * руками — если код истёк и нужен свежий.
 *
 * Код выводится из `SECRET_KEY`, поэтому команде нужно окружение площадки, а база — чтобы
 * не печатать код, который уже ничего не откроет. Код возврата 0 в обоих исходах: «первый
 * запуск не нужен» — не ошибка выкладки.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { firstRunCode } from './first-run.js';
import { IdentityService } from './identity.service.js';

async function main(): Promise<void> {
  // Как в `create-admin.ts`: `abortOnError: false`, иначе неверная конфигурация
  // выглядит молчаливым выходом с кодом 1 без слова о причине.
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
    if (!(await app.get(IdentityService).firstRunRequired())) {
      process.stdout.write('Администратор уже есть — первый запуск не нужен.\n');
      return;
    }
    const config = app.get<Config>(APP_CONFIG);
    const { code, validUntil } = firstRunCode(config.SECRET_KEY, new Date());
    const address = new URL('/setup', config.WEB_BASE_URL).toString();
    process.stdout.write(
      [
        'Первый запуск: администратора ещё нет.',
        `  Кабинет:  ${address}`,
        `  Код:      ${code}`,
        `  Действует до ${validUntil.toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
        '',
      ].join('\n'),
    );
  } catch (cause) {
    process.stderr.write(`Не удалось получить код первого запуска: ${String(cause)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
