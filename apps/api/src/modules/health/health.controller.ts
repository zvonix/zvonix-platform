/**
 * Проверки состояния для оркестратора и балансировщика.
 *
 * Две разные проверки, и путать их дорого:
 *   `/health/live`  — процесс жив. Не трогает зависимости. Если он отвечает ошибкой,
 *                     процесс нужно перезапускать.
 *   `/health/ready` — готов принимать трафик. Проверяет базу. Если база недоступна,
 *                     перезапуск не поможет — узел нужно вывести из балансировки,
 *                     но оставить работать.
 *
 * Одна общая проверка означает, что при недоступности базы оркестратор начнёт
 * перезапускать все экземпляры по кругу, добавляя нагрузку туда, где уже авария.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import { dependencyUnavailable } from '@zvonix/shared';
import { Public } from '../../http/auth.guard.js';
import { DatabaseService } from '../../infra/database.service.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', app: this.config.APP_NAME, env: this.config.APP_ENV };
  }

  @Public()
  @Get('ready')
  async ready() {
    if (!(await this.database.isReady())) {
      // 503 через доменную ошибку, а не ответ с полем `status: 'degraded'` и кодом 200:
      // балансировщик смотрит на код ответа, а не на тело.
      throw dependencyUnavailable('База данных недоступна');
    }
    return { status: 'ok', database: 'ok' };
  }
}
