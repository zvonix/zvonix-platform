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
import { DatabaseService } from '../infra/database.service.js';
import { BillingService } from '../modules/billing/billing.service.js';
import { CatalogService } from '../modules/catalog/catalog.service.js';
import { IdentityService } from '../modules/identity/identity.service.js';
import { TelephonyService } from '../modules/telephony/telephony.service.js';

/** Пароль стенда. Совпадает с `E2E_PASSWORD` в `scripts/e2e-stack.mjs`. */
const PASSWORD = 'Пров3рка-Кабинета!';

/**
 * Кто заводится. Адреса говорящие: по ним видно, чей это экран, прямо в отчёте.
 *
 * Участники рынка — роль `member`: кабинет открывает карточка, а не роль (ADR-0052).
 * `both` владеет и клиентом, и партнёром — на нём проверяется переключатель кабинетов.
 */
const PEOPLE: { key: string; email: string; role: UserRole; fullName: string }[] = [
  {
    key: 'admin',
    email: 'admin@e2e.zvonix.test',
    role: 'admin',
    fullName: 'Администратор Стендов',
  },
  {
    key: 'support',
    email: 'support@e2e.zvonix.test',
    role: 'support',
    fullName: 'Поддержка Стендова',
  },
  { key: 'client', email: 'client@e2e.zvonix.test', role: 'member', fullName: 'Диспетчер Волны' },
  {
    key: 'partner',
    email: 'partner@e2e.zvonix.test',
    role: 'member',
    fullName: 'Иванов Иван Иванович',
  },
  {
    key: 'both',
    email: 'both@e2e.zvonix.test',
    role: 'member',
    fullName: 'Петрова Анна Сергеевна',
  },
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

    const users = new Map<string, string>();
    for (const person of PEOPLE) {
      const created = await identity.createByAdmin({
        email: person.email,
        password: PASSWORD,
        fullName: person.fullName,
        role: person.role,
        status: 'active',
      });
      users.set(person.key, created.id);
    }

    const adminId = users.get('admin');
    const clientOwner = users.get('client');
    const partnerOwner = users.get('partner');
    const bothOwner = users.get('both');
    if (
      adminId === undefined ||
      clientOwner === undefined ||
      partnerOwner === undefined ||
      bothOwner === undefined
    ) {
      throw new Error('Учётные записи стенда не заведены');
    }

    const actor = { userId: parseId(adminId, 'user'), role: 'admin' as const };

    const client = await billing.createClient(
      {
        ownerUserId: parseId(clientOwner, 'user'),
        name: 'Такси «Волна»',
        overdraftLimit: Money.ZERO,
      },
      actor,
    );
    // Клиент звонит только в состоянии `active`, и его линия — тоже. Оставить их
    // в «ждёт» значило бы показывать на стенде кабинет, который ничего не может.
    await billing.changeClientStatus(client.id, 'active', actor);

    const { channel } = await telephony.createChannel(
      { clientId: client.id, name: 'Диспетчерская', recordingRequired: false, callerId: null },
      actor.userId,
      actor.role,
    );
    await telephony.setChannelStatus(channel.id, 'active', actor.userId, actor.role);

    const partner = await billing.createPartner(
      {
        ownerUserId: parseId(partnerOwner, 'user'),
        name: 'Иванов Иван Иванович',
        displayName: 'Партнёр 17',
      },
      actor,
    );
    await billing.changePartnerStatus(partner.id, 'verified', actor);

    // Один человек — два кабинета (ADR-0052): служба такси, у которой есть и свои SIM.
    const bothClient = await billing.createClient(
      { ownerUserId: parseId(bothOwner, 'user'), name: 'Такси «Бриз»', overdraftLimit: Money.ZERO },
      actor,
    );
    await billing.changeClientStatus(bothClient.id, 'active', actor);
    await billing.createPartner(
      {
        ownerUserId: parseId(bothOwner, 'user'),
        name: 'Петрова Анна Сергеевна',
        displayName: 'Партнёр 31',
      },
      actor,
    );

    // Оператор нужен кабинету партнёра: без него SIM не завести. Заводить его в самой
    // проверке значило бы проверять админку, а не то, что партнёр видит у себя.
    await app
      .get(CatalogService)
      .createOperator(
        { name: 'МегаФон', inn: null, mnc: null, isMvno: false, hostOperatorId: null, aliases: [] },
        actor,
      );

    // Очередь заявок (ADR-0052): партнёр с подтверждённой почтой — его можно одобрить,
    // служба такси без подтверждения — одобрение ей закрыто, и экран обязан это сказать.
    const database = app.get(DatabaseService);
    const applicants = [
      {
        email: 'applicant.partner@e2e.zvonix.test',
        fullName: 'Смирнов Олег Петрович',
        confirmed: true,
        application: {
          cabinet: 'partner' as const,
          answers: {
            region: 'Свердловская область',
            phone: '+7 912 604-18-33',
            simCount: 16,
            operators: ['МТС', 'T2'],
          },
        },
      },
      {
        email: 'applicant.client@e2e.zvonix.test',
        fullName: 'Кузнецова Мария',
        confirmed: false,
        application: {
          cabinet: 'client' as const,
          answers: {
            companyName: 'Такси «Север»',
            city: 'Екатеринбург',
            phone: '+7 343 000-00-00',
            callsPerDay: 800,
          },
        },
      },
    ];
    for (const applicant of applicants) {
      const user = await identity.createByAdmin({
        email: applicant.email,
        password: PASSWORD,
        fullName: applicant.fullName,
        role: 'member',
        status: 'pending',
      });
      await identity.createApplication(parseId(user.id, 'user'), applicant.application);
      if (applicant.confirmed) {
        await database.db.execute(
          sql`update users set email_confirmed_at = now() where id = ${user.id}`,
        );
      }
    }

    // Вход открыт вручную, а заявка не одобрена — кабинета нет. Так выглядел первый
    // живой партнёр (2026-09-23): экран обязан сказать, где заявка и что делать.
    const waiting = await identity.createByAdmin({
      email: 'waiting@e2e.zvonix.test',
      password: PASSWORD,
      fullName: 'Соколов Андрей',
      role: 'member',
      status: 'active',
    });
    await identity.createApplication(parseId(waiting.id, 'user'), {
      cabinet: 'partner',
      answers: { region: 'Тверская область', phone: '+7 910 000-11-22', operators: ['МТС'] },
    });

    process.stdout.write(
      'Стенд наполнен: роли, клиент с линией, подтверждённый партнёр, человек с двумя ' +
        'кабинетами, оператор, две заявки.\n',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Не удалось наполнить стенд: ${String(error)}\n`);
  process.exitCode = 1;
});
