/**
 * Привязка `dialplan`: узел спрашивает маршрут на каждый вызов (docs/api/node.md).
 *
 * Как и каталог, отвечает **всегда 200 и всегда XML**: любой другой код `mod_xml_curl`
 * отбрасывает целиком, и абонент слышит невнятный отбой вместо причины. Разбор тела
 * поэтому выполняется внутри обработчика, а не разборной трубой на входе — её ошибка
 * приходит объектом JSON при объявленном XML, и ответ превращается в 500.
 */

import { Body, Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { normalizeMsisdn, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine, Roles } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { rejectDocument, routeDocument, sipResponseFor } from './dialplan-xml.js';
import { dialplanRequestSchema, previewSchema } from './schemas.js';
import { RoutingService } from './routing.service.js';

@Controller()
export class RoutingController {
  private readonly logger: Logger;

  constructor(
    private readonly routing: RoutingService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('node-dialplan');
  }

  @Machine('node')
  @Post('node/dialplan')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  async dialplan(
    @Body() body: unknown,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<string> {
    const parsed = dialplanRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn('Запрос маршрута не разобран', {
        key_id: machine.keyId,
        problems: parsed.error.issues.map((issue) => issue.path.join('.') || '<корень>'),
      });
      return rejectDocument('internal_error');
    }

    const destination = normalizeMsisdn(parsed.data['Caller-Destination-Number']);
    if (destination === undefined) {
      // Номер, который мы не понимаем, — это не «оператор не подтверждён»,
      // а неверный набор. Для поддержки это разные разговоры.
      this.logger.warn('Номер назначения не разобран', { key_id: machine.keyId });
      return rejectDocument('operator_unconfirmed');
    }

    const decision = await this.routing.route({
      externalId: parsed.data['Unique-ID'],
      channelId: parseId(parsed.data['variable_zvonix_channel'], 'channel'),
      nodeId: parseId(machine.ownerId, 'node'),
      destination,
    });

    if (decision.outcome === 'rejected') {
      this.logger.info('Вызов отклонён', {
        reason: decision.reason,
        sip: sipResponseFor(decision.reason),
        call_id: decision.call?.id ?? null,
      });
      return rejectDocument(decision.reason);
    }

    return routeDocument({
      callId: decision.call.id,
      destination,
      realm: this.config.SIP_REALM,
      callerId: decision.callerId,
      recordingPath: decision.recordingRequired
        ? `$\${recordings_dir}/${decision.call.id}.wav`
        : null,
      candidates: decision.candidates.map((candidate) => ({
        gatewaySipUsername: candidate.gateway.sipUsername,
      })),
    });
  }

  /**
   * Тот же расчёт для человека — **с теми же побочными действиями**, что и настоящий.
   *
   * Честнее, чем расчёт «вхолостую»: маршрут без резерва и без записи вызова отвечал бы
   * на другой вопрос, чем задан. Отличие только в идентификаторе вызова, который задаёт
   * вызывающий, — по нему разбор виден в списке вызовов канала как обычный.
   */
  @Roles('admin', 'support')
  @Post('routing/preview')
  async preview(@Body(zodBody(previewSchema)) body: z.infer<typeof previewSchema>): Promise<{
    outcome: string;
    reason: string | null;
    sip_response: string | null;
    call_id: string | null;
    candidates: { gateway_id: string; sip_username: string; sim_card_id: string }[];
  }> {
    const decision = await this.routing.route({
      externalId: body.callId,
      channelId: parseId(body.channelId, 'channel'),
      nodeId: parseId(body.nodeId, 'node'),
      destination: body.destination,
    });

    if (decision.outcome === 'rejected') {
      return {
        outcome: 'rejected',
        reason: decision.reason,
        sip_response: sipResponseFor(decision.reason),
        call_id: decision.call?.id ?? null,
        candidates: [],
      };
    }

    return {
      outcome: 'routed',
      reason: null,
      sip_response: null,
      call_id: decision.call.id,
      candidates: decision.candidates.map((candidate) => ({
        gateway_id: candidate.gateway.id,
        sip_username: candidate.gateway.sipUsername,
        sim_card_id: candidate.sim.id,
      })),
    };
  }
}
