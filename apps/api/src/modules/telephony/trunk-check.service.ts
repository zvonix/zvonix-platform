/**
 * Проверка связи узла с SIP-провайдером ([ADR-0122](../../../../../docs/adr/0122-proverka-svyazi-s-sip-provayderom.md)).
 *
 * «Провайдер не отвечает» (код 908) бывает и у провайдера, и в сети между узлом и им, а поддержка провайдера
 * отвечает «подключений с вашего адреса не было». Узел по команде записывает трафик к адресам провайдера,
 * сразу просит FreeSWITCH зарегистрироваться и сообщает, сколько запросов ушло и сколько ответов пришло.
 * Здесь — только постановка команды и разбор ответа: решает и считает скрипт узла (`node/install.sh`).
 */

import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, type Id } from '@zvonix/shared';
import { EslError } from '../../infra/esl.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { NodeCommandsService } from '../nodes/node-commands.service.js';
import { TelephonyRepository } from './telephony.repository.js';

/** Скрипт узла слушает 35 с и отвечает за секунды после; запас — на очередь и доставку ответа. */
const CHECK_TIMEOUT_MS = 60_000;

/** Строка итога в ответе узла — первая, с этим началом. */
const SUMMARY_PREFIX = 'ИТОГ: ';

export interface TrunkCheckResult {
  /** Итог одной фразой по-русски. */
  readonly summary: string;
  /** Подробности: адреса, маршрут, пакеты, состояние регистрации. Пусто — узел их не прислал. */
  readonly details: string;
}

@Injectable()
export class TrunkCheckService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: TelephonyRepository,
    private readonly commands: NodeCommandsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('trunk-check');
  }

  /** `partnerId` — проверка из кабинета партнёра: чужой транк не находится (404), как и несуществующий. */
  async check(gatewayId: Id<'gateway'>, partnerId?: Id<'partner'>): Promise<TrunkCheckResult> {
    const found = await this.repository.findTrunk(gatewayId);
    if (found === undefined || (partnerId !== undefined && found.gateway.partnerId !== partnerId)) {
      throw notFound('SIP-провайдер не найден');
    }
    if (found.gateway.status === 'retired') throw conflict('SIP-провайдер удалён');
    const nodeId = found.gateway.nodeId;
    if (nodeId === null) throw conflict('SIP-провайдер не привязан к узлу АТС');

    let reply: string;
    try {
      reply = await this.commands.run(
        nodeId,
        `zvonix-sip-check ${found.gateway.sipUsername}`,
        CHECK_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof EslError)) throw error;
      this.logger.warn('Проверка связи с провайдером не выполнена', {
        gateway_id: gatewayId,
        failure: error.failure,
      });
      return {
        summary:
          error.failure === 'timeout'
            ? 'Узел не прислал итог проверки вовремя — повторите через минуту'
            : 'Узел АТС сейчас не принимает команды — проверьте, на связи ли он',
        details: '',
      };
    }
    const result = parseReply(reply);
    this.logger.info('Проверка связи с провайдером', {
      gateway_id: gatewayId,
      summary: result.summary,
    });
    return result;
  }
}

/** Ответ узла: первая строка — итог, остальное — подробности. Старый узел команду не знает. */
export function parseReply(reply: string): TrunkCheckResult {
  const text = reply.trim();
  if (text.startsWith('-ERR')) {
    return {
      summary:
        'Узел ещё не обновился и не умеет эту проверку — подождите несколько минут после обновления площадки',
      details: '',
    };
  }
  const [first = '', ...rest] = text.split('\n');
  if (!first.startsWith(SUMMARY_PREFIX)) {
    return { summary: 'Узел прислал непонятный ответ — подробности ниже', details: text };
  }
  return { summary: first.slice(SUMMARY_PREFIX.length).trim(), details: rest.join('\n').trim() };
}
