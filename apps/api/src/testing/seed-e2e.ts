/**
 * Наполнение стенда для сквозных проверок кабинета.
 *
 * Заводит по одной учётной записи на роль и минимум данных, без которых разделы
 * нечем показать: клиента с линией и подтверждённого партнёра.
 *
 * Через службы, а не через API: учётную запись администратора и поддержки в API
 * завести нечем вовсе (см. `create-admin.ts`), а самостоятельная регистрация тянет
 * за собой капчу и подтверждение адреса — то есть проверяла бы почту, а не кабинет.
 *
 * По форме — брат `create-admin.ts`: поднимает контекст приложения, делает своё
 * и гаснет. Один подъём вместо четырёх запусков команды.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { applyMigrations, createDatabase } from '@zvonix/db';
import { Money, parseId, type UserRole } from '@zvonix/shared';
import { sql } from 'drizzle-orm';
import { AppModule } from '../app.module.js';
import { BillingService } from '../modules/billing/billing.service.js';
import { IdentityService } from '../modules/identity/identity.service.js';
import { TelephonyService } from '../modules/telephony/telephony.service.js';

/** Пароль стенда. Совпадает с `E2E_PASSWORD` в `scripts/e2e-stack.mjs`. */
const PASSWORD = 'Пров3рка-Кабинета!';

/** Кто заводится. Адреса говорящие: по ним видно, чей это экран, прямо в отчёте. */
const PEOPLE: { email: string; role: UserRole; fullName: string }[] = [
  { email: 'admin@e2e.zvonix.test', role: 'admin', fullName: 'Администратор Стендов' },
  { email: 'support@e2e.zvonix.test', role: 'support', fullName: 'Поддержка Стендова' },
  { email: 'client@e2e.zvonix.test', role: 'client', fullName: 'Диспетчер Волны' },
  { email: 'partner@e2e.zvonix.test', role: 'partner', fullName: 'Иванов Иван Иванович' },
];

/**
 * Приводит базу к состоянию сразу после миграций.
 *
 * Здесь, а не в запускающем скрипте: сброс требует пакета базы, а корень
 * монорепозитория его не зависимость — и заводить её там ради одного вызова
 * значило бы объявить корню то, чем пользуется один скрипт.
 *
 * Рубеж тот же, что у стенда проверок API: имя базы обязано кончаться на `_test`.
 * Скрипт сносит схему целиком, и ошибка в адресе стоила бы рабочих данных.
 */
async function resetDatabase(url: string): Promise<void> {
  if (!/_test(\?|$)/u.test(url)) {
    throw new Error(`Адрес базы не похож на тестовый: ${url}. Имя обязано кончаться на _test.`);
  }

  const handle = createDatabase({ url, poolMax: 1, statementTimeoutMs: 0 });
  try {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await applyMigrations(handle.db);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('Не задан DATABASE_URL');
  await resetDatabase(url);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const identity = app.get(IdentityService);
    const billing = app.get(BillingService);
    const telephony = app.get(TelephonyService);

    const users = new Map<UserRole, string>();
    for (const person of PEOPLE) {
      const created = await identity.createByAdmin({
        email: person.email,
        password: PASSWORD,
        fullName: person.fullName,
        role: person.role,
        status: 'active',
      });
      users.set(person.role, created.id);
    }

    const adminId = users.get('admin');
    const clientOwner = users.get('client');
    const partnerOwner = users.get('partner');
    if (adminId === undefined || clientOwner === undefined || partnerOwner === undefined) {
      throw new Error('Учётные записи стенда не заведены');
    }

    const actor = { userId: parseId(adminId, 'user'), role: 'admin' as const };

    const client = await billing.createClient({
      ownerUserId: parseId(clientOwner, 'user'),
      name: 'Такси «Волна»',
      overdraftLimit: Money.ZERO,
    });
    // Клиент звонит только в состоянии `active`, и его линия — тоже. Оставить их
    // в «ждёт» значило бы показывать на стенде кабинет, который ничего не может.
    await billing.changeClientStatus(client.id, 'active', actor);

    const { channel } = await telephony.createChannel(
      { clientId: client.id, name: 'Диспетчерская', recordingRequired: false, callerId: null },
      actor.userId,
      actor.role,
    );
    await telephony.setChannelStatus(channel.id, 'active', actor.userId, actor.role);

    const partner = await billing.createPartner({
      ownerUserId: parseId(partnerOwner, 'user'),
      name: 'Иванов Иван Иванович',
      displayName: 'Партнёр 17',
    });
    await billing.changePartnerStatus(partner.id, 'verified', actor);

    process.stdout.write('Стенд наполнен: четыре роли, клиент с линией, подтверждённый партнёр.\n');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Не удалось наполнить стенд: ${String(error)}\n`);
  process.exitCode = 1;
});
