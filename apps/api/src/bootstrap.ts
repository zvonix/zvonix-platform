/**
 * Сборка приложения.
 *
 * Вынесено из `main.ts`, чтобы тесты поднимали ровно то же приложение, что и production,
 * а не свою урезанную сборку. Настройка, включённая только в `main.ts`, не проверяется
 * ни одним тестом — и ломается незаметно.
 */

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@zvonix/config';
import type { Logger } from '@zvonix/logger';
import { AppModule } from './app.module.js';
import { registerCorrelationId } from './http/correlation-id.hook.js';
import { APP_CONFIG, APP_LOGGER, type Config } from './infra/tokens.js';

/** Верхняя граница тела запроса. Больше в этом API отправлять нечего. */
const MAX_BODY_BYTES = 256 * 1024;

export interface BuiltApplication {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly logger: Logger;
}

export async function buildApplication(): Promise<BuiltApplication> {
  // Конфигурация нужна до сборки контейнера: адаптер создаётся раньше него, а настройка
  // доверия прокси задаётся именно при создании. Чтение дешёвое и без побочных действий,
  // так что второе обращение здесь — это повторная работа, а не второй источник истины.
  const settings = loadConfig();

  const adapter = new FastifyAdapter({
    bodyLimit: MAX_BODY_BYTES,
    /**
     * Кому верить, когда в запросе есть `X-Forwarded-For`.
     *
     * Раньше здесь стояло `true`, то есть «верить всем». От `request.ip` зависят список
     * разрешённых адресов машинного ключа (ADR-0019), ограничение частоты входа и адрес
     * в журнале аудита — и заголовок ставит клиент. Значит, украденный ключ узла работал
     * бы откуда угодно, ограничение обходилось бы сменой заголовка, а в журнал попадал бы
     * адрес, выбранный тем, кого мы записываем. ADR-0019 это прямо запрещает.
     */
    trustProxy: settings.TRUSTED_PROXIES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Свой логгер (ADR-0004). Штатный вывод NestJS оставлен только для сообщений
    // самого фреймворка при старте.
    bufferLogs: true,
    // Ошибку провайдера NestJS по умолчанию перехватывает и завершает процесс сам,
    // до вызывающего кода. Тогда неверная конфигурация выглядит как молчаливый выход
    // с кодом 1, и причину приходится искать наугад.
    abortOnError: false,
  });

  const config = app.get<Config>(APP_CONFIG);
  const logger = app.get<Logger>(APP_LOGGER);

  registerCorrelationId(app.getHttpAdapter().getInstance());

  // Разбор `application/x-www-form-urlencoded` отдельно включать не нужно: адаптер
  // NestJS регистрирует его сам. Плагин `@fastify/formbody` поверх этого даёт второй
  // обработчик того же типа, и приложение падает при старте — проверено.
  // Формат нужен ровно одному обработчику: привязке `directory` для FreeSWITCH,
  // у которого другого формата нет (docs/api/node.md).

  // Файл записи принимается потоком, а не разбирается как тело: Fastify отдаёт обработчику
  // сам поток (ADR-0063). Без парсера для этих типов он ответил бы 415.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'],
      (_request, payload, done) => {
        done(null, payload);
      },
    );

  // Без этого `onApplicationShutdown` не вызывается, и пул соединений остаётся
  // открытым после SIGTERM: оркестратор добьёт процесс по таймауту.
  app.enableShutdownHooks();

  return { app, config, logger };
}
