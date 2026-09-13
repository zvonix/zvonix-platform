/**
 * Раздача установщика узла — `GET /install.sh`
 * ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md)).
 *
 * Панель составляет команду `curl … | sudo bash -s -- <токен>` с этим адресом, и до
 * появления этого обработчика она вела в `404`: команда была, отдавать её было некому.
 *
 * Обработчик **публичный** намеренно: в отдаваемом скрипте нет ни одного секрета —
 * токен передаётся аргументом команды, а ключ узла появляется только на самом узле.
 * Закрывать раздачу было бы нечем: `curl` на чистой машине ещё ничем не располагает.
 */

import { Controller, Get, Header, Res } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { dependencyUnavailable } from '@zvonix/shared';
import { Public } from '../../http/auth.guard.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

/**
 * Каталог `node/` разрешается от этого файла, а не от рабочего каталога процесса —
 * тем же способом, что и каталог миграций в `@zvonix/db`. Собранный код лежит
 * в `apps/api/dist/modules/nodes`, исходный — в `apps/api/src/modules/nodes`:
 * глубина одинаковая, и путь наверх один и тот же.
 */
const NODE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'node',
);

const INSTALL_SCRIPT = path.join(NODE_DIR, 'install.sh');
const TEMPLATES = {
  '@@TEMPLATE_XML_CURL@@': path.join(NODE_DIR, 'conf', 'autoload_configs', 'xml_curl.conf.xml'),
  '@@TEMPLATE_JSON_CDR@@': path.join(NODE_DIR, 'conf', 'autoload_configs', 'json_cdr.conf.xml'),
} as const;

@Controller()
export class NodeInstallController {
  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}

  /**
   * Скрипт установки, собранный под эту площадку.
   *
   * Отдаётся `text/x-shellscript` и без кэширования: команда выпускается под конкретный
   * узел, и промежуточный кэш, отдавший вчерашний скрипт с прежним адресом репозитория,
   * проявился бы установкой, которая «работала на прошлой неделе».
   */
  @Public()
  @Get('install.sh')
  @Header('content-type', 'text/x-shellscript; charset=utf-8')
  @Header('cache-control', 'no-store')
  async script(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    // Незаданный репозиторий — не повод отказывать: он нужен только затем, чтобы
    // **поставить** FreeSWITCH, а стоит он уже или нет, видно только на самой машине
    // ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md), «Ревизия»).
    // Скрипт разберётся на месте: нечего ставить — репозиторий не спросит вовсе,
    // есть что — откажется и назовёт эту переменную.
    reply.header('content-disposition', 'inline; filename="install.sh"');
    return this.compose(this.config.NODE_PACKAGE_REPO_URL);
  }

  /**
   * Собирает скрипт: сначала параметры, потом шаблоны.
   *
   * Порядок строгий. Обратный затёр бы `@@KEY_ID@@` и `@@KEY_SECRET@@` **внутри**
   * вложенного XML — а их подставляет сам скрипт на узле: до обмена токена ключа
   * не существует, и здесь его взять неоткуда.
   */
  private async compose(repository: string): Promise<string> {
    const [source, xmlCurl, jsonCdr] = await Promise.all([
      this.read(INSTALL_SCRIPT),
      this.read(TEMPLATES['@@TEMPLATE_XML_CURL@@']),
      this.read(TEMPLATES['@@TEMPLATE_JSON_CDR@@']),
    ]);

    const withSettings = source
      .replaceAll('@@CONTROL_PLANE@@', this.config.PUBLIC_BASE_URL.replace(/\/+$/u, ''))
      .replaceAll('@@PACKAGE_REPO@@', repository.replace(/\/+$/u, ''))
      .replaceAll('@@PACKAGE_SUITE@@', this.config.NODE_PACKAGE_SUITE)
      .replaceAll('@@PACKAGE_KEY_FINGERPRINT@@', this.config.NODE_PACKAGE_KEY_FINGERPRINT);

    return withSettings
      .replaceAll('@@TEMPLATE_XML_CURL@@', xmlCurl.trimEnd())
      .replaceAll('@@TEMPLATE_JSON_CDR@@', jsonCdr.trimEnd());
  }

  /**
   * Чтение файла из `node/`.
   *
   * Отсутствие файла — это неполный артефакт выкладки, а не ошибка запроса: `node/`
   * уезжает вместе с приложением так же, как каталог миграций. Отказ называет путь,
   * иначе разбираться пришлось бы по одному слову «не найдено».
   */
  private async read(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      throw dependencyUnavailable('Установщик узла недоступен', {
        details: { file, remedy: 'В артефакт выкладки не попал каталог node/.' },
      });
    }
  }
}
