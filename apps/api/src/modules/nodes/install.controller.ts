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
import type { FastifyReply } from 'fastify';
import { Public } from '../../http/auth.guard.js';
import { NodeSetService } from './node-set.service.js';

@Controller()
export class NodeInstallController {
  constructor(private readonly nodeSet: NodeSetService) {}

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
    return this.nodeSet.script();
  }
}
