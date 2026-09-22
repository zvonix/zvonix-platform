/**
 * Создание служебной учётной записи: `pnpm --filter @zvonix/api admin:create`.
 *
 * Нужна отдельная команда, а не «первый зарегистрировавшийся становится админом»:
 * такое правило означает, что окно между выкладкой и первой регистрацией отдаёт
 * полный доступ любому, кто узнает адрес.
 *
 * Пароль читается из переменной окружения, а не из аргумента командной строки:
 * аргументы видны в списке процессов и остаются в истории оболочки.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../../app.module.js';
import { IdentityService } from './identity.service.js';

/**
 * Роли, которые заводятся только этой командой.
 *
 * Самостоятельная регистрация их не выдаёт (`SELF_SERVICE_ROLES` — `client` и `partner`),
 * а обработчика заведения учётной записи администратором в API нет. Без этой команды
 * учётную запись поддержки завести было нечем, кроме правки в базе.
 */
const STAFF_ROLES = ['admin', 'support'] as const;

const inputSchema = z.object({
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email('не похож на адрес почты')),
  ADMIN_PASSWORD: z.string().min(12, 'не короче 12 символов'),
  ADMIN_NAME: z.string().trim().min(2, 'слишком короткое').default('Администратор'),
  ADMIN_ROLE: z.enum(STAFF_ROLES).default('admin'),
});

async function main(): Promise<void> {
  const input = inputSchema.safeParse(process.env);
  if (!input.success) {
    process.stderr.write(
      'Задайте ADMIN_EMAIL, ADMIN_PASSWORD и, при желании, ADMIN_NAME и ADMIN_ROLE ' +
        '(admin либо support).\n' +
        input.error.issues
          .map((issue) => `  ${String(issue.path[0])}: ${issue.message}`)
          .join('\n') +
        '\n',
    );
    process.exitCode = 1;
    return;
  }

  // Поднимается всё приложение целиком: администратор создаётся тем же кодом,
  // что и любая другая учётная запись, включая параметры хеширования пароля.
  // `abortOnError: false` обязателен: иначе NestJS перехватывает ошибку провайдера
  // и завершает процесс сам, до нашего обработчика. Неверная конфигурация тогда
  // выглядит как молчаливый выход с кодом 1 — без единого слова о причине.
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

  try {
    const created = await app.get(IdentityService).createByAdmin({
      email: input.data.ADMIN_EMAIL,
      password: input.data.ADMIN_PASSWORD,
      fullName: input.data.ADMIN_NAME,
      role: input.data.ADMIN_ROLE,
      status: 'active',
    });
    process.stdout.write(
      `Учётная запись создана: ${created.email} (${created.id}), роль ${created.role}\n`,
    );
  } catch (cause) {
    process.stderr.write(`Не удалось создать учётную запись: ${String(cause)}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
