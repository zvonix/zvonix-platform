/**
 * Приём CDR от узла (docs/api/node.md).
 *
 * Коды ответа здесь, в отличие от каталога и диалплана, обычные — и **управляют поведением
 * узла**: `mod_json_cdr` при неуспехе повторяет, а затем кладёт CDR на диск в `err-log-dir`.
 *
 *   `200` — принят, в том числе повторно. Узел забывает CDR;
 *   `400` — тело не разбирается. Повторять бессмысленно, но человек обязан увидеть,
 *           поэтому CDR ложится на диск, а не пропадает;
 *   `5xx` — временная неисправность. Узел повторит, потом положит на диск.
 *
 * Файлы в `err-log-dir` — это невыставленные счета. Их накопление должно поднимать
 * тревогу, а не лежать до первой жалобы.
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { parseId, validationFailed } from '@zvonix/shared';
import { Machine, Roles } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { CdrParseError } from './cdr-parse.js';
import { CdrService } from './cdr.service.js';

interface CallView {
  readonly id: string;
  readonly external_id: string;
  readonly destination: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly duration_seconds: number | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

@Controller()
export class CdrController {
  private readonly logger: Logger;

  constructor(
    private readonly cdr: CdrService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('cdr-intake');
  }

  @Machine('node')
  @Post('node/cdr')
  @HttpCode(200)
  async accept(
    @Body() body: unknown,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ accepted: boolean; outcome: string }> {
    try {
      const outcome = await this.cdr.accept(body);
      return { accepted: true, outcome: outcome.kind };
    } catch (cause) {
      if (cause instanceof CdrParseError) {
        // Неразбираемое тело — не временная неисправность: повторять его бессмысленно.
        // Отдаём `400`, чтобы узел положил CDR на диск и человек увидел, что именно
        // пришло. Молча принять такой CDR значило бы потерять деньги без следа.
        this.logger.error('CDR не разобран', cause, { key_id: machine.keyId });
        throw validationFailedFrom(cause);
      }
      throw cause;
    }
  }

  /**
   * Вызовы канала — для разбора «за что списали» и «почему не звонило».
   *
   * Отказы здесь видны наравне с состоявшимися вызовами: у них статус `failed`
   * и причина, ради которой они и записываются.
   */
  @Roles('admin', 'support')
  @Get('channels/:id/calls')
  async listCalls(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<{ calls: CallView[] }> {
    const rows = await this.cdr.listByChannel(parseId(id, 'channel'), boundedLimit(limit));
    return {
      calls: rows.map((row) => ({
        id: row.id,
        external_id: row.externalId,
        destination: row.destination,
        status: row.status,
        failure_reason: row.failureReason,
        duration_seconds: row.durationSeconds,
        started_at: row.startedAt.toISOString(),
        ended_at: row.endedAt?.toISOString() ?? null,
      })),
    };
  }
}

/** Верхняя граница выборки: без неё запрос без параметра выгружает всю историю канала. */
function boundedLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 1000);
}

/**
 * Ошибка разбора CDR в доменном виде.
 *
 * Текст исходной ошибки в ответ не уходит: узлу он ни к чему, а в логе он уже есть
 * вместе с ключом, по которому видно, какой узел прислал.
 */
function validationFailedFrom(cause: CdrParseError): Error {
  return validationFailed('CDR не разобран', { cause });
}
