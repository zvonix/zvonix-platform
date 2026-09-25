/**
 * Привязка `dialplan`: узел спрашивает маршрут на каждый вызов (docs/api/node.md).
 *
 * Как и каталог, отвечает **всегда 200 и всегда XML**: любой другой код `mod_xml_curl`
 * отбрасывает целиком, и абонент слышит невнятный отбой вместо причины. Разбор тела
 * поэтому выполняется внутри обработчика, а не разборной трубой на входе — её ошибка
 * приходит объектом JSON при объявленном XML, и ответ превращается в 500.
 */

import { Body, Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { goipLinePrefix, parseId, terminationKindOf } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine, Roles } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import type { TerminationCandidate } from '../telephony/telephony.repository.js';
import { rejectDocument, routeDocument, sipResponseFor } from './dialplan-xml.js';
import { dialplanRequestSchema, previewSchema } from './schemas.js';
import { RoutingService } from './routing.service.js';

/**
 * Когда решение о маршруте считается медленным.
 *
 * Секунда — не бюджет, а признак неисправности: внутри решения уже есть внешнее
 * определение оператора со своим пределом в 800 мс (docs/api/node.md), а всё остальное —
 * чтения по индексам. Дольше секунды означает, что медленно что-то ещё, и знать об этом
 * надо раньше, чем узел начнёт отваливаться по своему тайм-ауту.
 */
const SLOW_DECISION_MS = 1000;

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

    // Номер уходит в решение **как набран**: приведение к каноническому виду делает
    // маршрутизация, потому что отказ по неразобранному номеру пишется вызовом,
    // а вызову нужен известный канал (ADR-0042).
    const startedAt = performance.now();
    const decision = await this.routing.route({
      externalId: parsed.data['Unique-ID'],
      channelId: parseId(parsed.data['variable_zvonix_channel'], 'channel'),
      nodeId: parseId(machine.ownerId, 'node'),
      dialled: parsed.data['Caller-Destination-Number'],
    });
    this.warnIfSlow(startedAt, parsed.data['Unique-ID']);

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
      // Из вызова, а не из запроса: в запросе набранное, а набирать надо канонический.
      destination: decision.call.destination,
      realm: this.config.SIP_REALM,
      callerId: decision.callerId,
      recordingPath: decision.recordingRequired
        ? `$\${recordings_dir}/${decision.call.id}.wav`
        : null,
      candidates: decision.candidates.map((candidate) => ({
        kind: terminationKindOf(candidate.gateway.type),
        ...dialTargetOf(candidate),
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
    decision_ms: number;
    candidates: {
      gateway_id: string;
      sip_username: string;
      termination_kind: string;
      sim_card_id: string | null;
      line_prefix: string | null;
    }[];
  }> {
    const startedAt = performance.now();
    const decision = await this.routing.route({
      externalId: body.callId,
      channelId: parseId(body.channelId, 'channel'),
      nodeId: parseId(body.nodeId, 'node'),
      dialled: body.destination,
    });
    // Сколько заняло решение — единственный способ узнать это, не заводя нагрузочный
    // стенд: разбор выполняет ровно тот же путь, что и настоящий вызов.
    const decisionMs = this.warnIfSlow(startedAt, body.callId);

    if (decision.outcome === 'rejected') {
      return {
        outcome: 'rejected',
        reason: decision.reason,
        sip_response: sipResponseFor(decision.reason),
        call_id: decision.call?.id ?? null,
        decision_ms: decisionMs,
        candidates: [],
      };
    }

    return {
      outcome: 'routed',
      reason: null,
      sip_response: null,
      call_id: decision.call.id,
      decision_ms: decisionMs,
      candidates: decision.candidates.map((candidate) => {
        const target = dialTargetOf(candidate);
        return {
          gateway_id: candidate.gateway.id,
          // Учётная запись, которую набирает узел: у входа по линиям — вход порта (ADR-0054).
          sip_username: target.sipUsername,
          termination_kind: terminationKindOf(candidate.gateway.type),
          // У транка SIM нет: ёмкость у него своя, и подставлять сюда нечего.
          sim_card_id: candidate.kind === 'sim' ? candidate.sim.id : null,
          // Каким префиксом узел выберет линию GOIP — то, что проверяют при настройке шлюза.
          line_prefix: target.linePrefix,
        };
      }),
    };
  }

  /**
   * Замечает медленное решение и возвращает его длительность.
   *
   * Каждое решение в лог не пишется: их столько же, сколько вызовов. Пишется только то,
   * что вышло за признак неисправности, — иначе о замедлении узнают от узла, когда он
   * начнёт отваливаться по своему тайм-ауту.
   */
  private warnIfSlow(startedAt: number, externalId: string): number {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs > SLOW_DECISION_MS) {
      this.logger.warn('Решение о маршруте заняло дольше ожидаемого', {
        duration_ms: durationMs,
        slow_after_ms: SLOW_DECISION_MS,
        external_id: externalId,
      });
    }
    return durationMs;
  }
}

/**
 * Кого набирать и с каким префиксом.
 *
 * Линию GOIP выбирает площадка, а не шлюз, и двумя способами
 * ([ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)): при входе по линиям —
 * учётной записью самой линии, без префикса; при входе на шлюз — префиксом линии
 * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md)). У телефона слот
 * один, у транка SIM нет — набирается шлюз как есть.
 */
function dialTargetOf(candidate: TerminationCandidate): {
  sipUsername: string;
  linePrefix: string | null;
} {
  if (candidate.kind !== 'sim' || candidate.gateway.type !== 'goip') {
    return { sipUsername: candidate.gateway.sipUsername, linePrefix: null };
  }
  if (candidate.gateway.registrationMode === 'port') {
    // Отбор берёт у такого шлюза только порт с выданным и зарегистрированным входом.
    // Пустое имя здесь — рассогласование данных, и набирать вместо линии шлюз целиком
    // значило бы позвонить с неизвестной SIM.
    if (candidate.port.sipUsername === null) {
      throw new Error(`У порта ${candidate.port.id} нет входа линии, а отбор его пропустил`);
    }
    return { sipUsername: candidate.port.sipUsername, linePrefix: null };
  }
  return {
    sipUsername: candidate.gateway.sipUsername,
    linePrefix: goipLinePrefix(candidate.port.portNumber),
  };
}
