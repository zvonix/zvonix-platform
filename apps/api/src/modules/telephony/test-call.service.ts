/**
 * Тестовый звонок с SIM ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 *
 * Площадка сама звонит с выбранной карты через ESL узла. Проверяется ровно одно —
 * работают ли GOIP, линия и SIM: ни клиента, ни цены, ни оператора номера здесь нет,
 * и звонок в деньгах не участвует.
 */

import { Inject, Injectable } from '@nestjs/common';
import { maskPhone } from '@zvonix/logger';
import {
  conflict,
  notFound,
  parseMsisdn,
  TEST_CALL_STALE_AFTER_MS,
  TESTABLE_SIM_STATUSES,
  type Id,
  type TestCallStatus,
  type UserRole,
} from '@zvonix/shared';
import { EslError, eslApi, type EslTarget } from '../../infra/esl.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BlockedNumberService } from '../catalog/blocked-numbers.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import type { ParsedCdr } from './cdr-parse.js';
import { statusFromHangupCause } from './cdr-parse.js';
import { simDialTarget, simEndpoint } from './sim-dial.js';
import { TelephonyRepository, type SimCardId } from './telephony.repository.js';
import { TestCallRepository, type TestCallId, type TestCallRow } from './test-call.repository.js';

/** Сколько узел ждёт ответа абонента. Дольше — это уже не проба, а ожидание. */
const ORIGINATE_TIMEOUT_SECONDS = 40;

/**
 * Срок на всю команду ESL: дозвон плюс запас на соединение и ответ узла. Сигналы после
 * ответа сюда не входят — `originate` отвечает в момент ответа абонента.
 */
const ESL_COMMAND_TIMEOUT_MS = (ORIGINATE_TIMEOUT_SECONDS + 15) * 1000;

/**
 * Что услышит ответивший: пять коротких сигналов 425 Гц — тон отечественной АТС,
 * его не спутать с речью. После них вызов кладётся сам.
 */
const TEST_TONE = 'tone_stream://L=5;%(400,600,425)';

/** Кто просит пробу. Партнёр — только со своих карт, администратор — с любых. */
export interface TestCallActor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  /** Пусто у сотрудника площадки; у партнёра — его карточка. */
  readonly partnerId?: Id<'partner'>;
}

@Injectable()
export class TestCallService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: TestCallRepository,
    private readonly telephony: TelephonyRepository,
    private readonly nodes: NodesService,
    private readonly blocked: BlockedNumberService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('test-call');
  }

  /**
   * Начинает пробу и сразу возвращает запись в `dialing`: дозвон идёт до сорока секунд,
   * и держать всё это время запрос кабинета нельзя. Итог дописывается в фоне.
   */
  async start(
    simId: SimCardId,
    rawDestination: string,
    actor: TestCallActor,
  ): Promise<TestCallRow> {
    const destination = parseMsisdn(rawDestination, 'destination');

    const sim = await this.telephony.findSim(simId);
    // Чужая карта для партнёра — «не найдена», а не «запрещено»: иначе по разнице
    // ответов перебираются чужие идентификаторы.
    if (sim === undefined || (actor.partnerId !== undefined && sim.partnerId !== actor.partnerId)) {
      throw notFound('SIM-карта не найдена');
    }
    if (!TESTABLE_SIM_STATUSES.includes(sim.status)) {
      throw conflict(
        sim.status === 'retired'
          ? 'Карта списана — с неё больше не звонят'
          : 'Карта заблокирована — с неё не звонят, пока её не разблокирует администратор',
        { details: { reason: 'sim_not_testable', sim_status: sim.status } },
      );
    }

    if ((await this.blocked.findBlock(destination)) !== undefined) {
      throw conflict('Номер в чёрном списке площадки — на него не звонят', {
        details: { reason: 'destination_blocked' },
      });
    }

    const port = await this.telephony.findPortBySim(sim.id);
    if (port === undefined) {
      throw conflict('Карта не вставлена в порт шлюза — вставьте её, чтобы позвонить', {
        details: { reason: 'sim_not_in_port' },
      });
    }
    const gateway = await this.telephony.findGateway(port.gatewayId);
    if (gateway === undefined) throw notFound('Шлюз карты не найден');
    if (gateway.status === 'retired') {
      throw conflict('Шлюз удалён — с его карт не звонят', {
        details: { reason: 'gateway_retired' },
      });
    }

    const byLine = gateway.type === 'goip' && gateway.registrationMode === 'port';
    if (byLine && port.sipUsername === null) {
      throw conflict('У линии нет входа — выдайте вход линии и введите его в GOIP', {
        details: { reason: 'line_without_account' },
      });
    }
    const nodeId = byLine ? port.nodeId : gateway.nodeId;
    if (nodeId === null) {
      throw conflict(
        byLine
          ? 'Линия ещё не подключилась к площадке — проверьте логин и пароль линии в GOIP'
          : 'Шлюз ещё не подключился к площадке — проверьте логин и пароль в GOIP',
        { details: { reason: 'not_registered' } },
      );
    }

    const esl = await this.nodes.eslTargetOf(nodeId);
    if (esl === undefined) {
      throw conflict(
        'Узел площадки пока не принимает команды на звонок — напишите администратору площадки',
        { details: { reason: 'node_not_ready' } },
      );
    }

    const target = simDialTarget(gateway, port);
    const row = await this.telephony.transaction(async (tx) => {
      // Карта запирается, чтобы две пробы одновременно не прошли проверку «идёт ли уже»
      // вместе. Предела «раз в минуту» больше нет (владелец, 2026-09-29: «убери это
      // ограничение»); одна проба одновременно остаётся — вторая застала бы линию занятой.
      await this.telephony.lockSimCard(sim.id, tx);
      const now = Date.now();
      await this.repository.expireStale(sim.id, new Date(now - TEST_CALL_STALE_AFTER_MS), tx);

      const last = await this.repository.lastForSim(sim.id, tx);
      if (last?.status === 'dialing') {
        throw conflict('С этой карты уже идёт тестовый звонок — дождитесь итога', {
          details: { reason: 'test_call_in_progress', test_call_id: last.id },
        });
      }

      return this.repository.create(
        {
          simCardId: sim.id,
          partnerId: sim.partnerId,
          gatewayId: gateway.id,
          portNumber: port.portNumber,
          nodeId,
          destination,
          sipUsername: target.sipUsername,
          requestedBy: actor.userId,
        },
        tx,
      );
    });

    await this.audit.record({
      action: 'sim_card.test_call',
      entityType: 'sim_card',
      entityId: sim.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      // Номер — персональные данные: в журнале только опознаваемый след.
      after: {
        test_call_id: row.id,
        destination: maskPhone(destination),
        gateway_id: gateway.id,
        port_number: port.portNumber,
      },
    });

    const endpoint = simEndpoint(target, destination, this.config.SIP_REALM);
    // Не ждём: итог дописывается сам. Ошибка фона не должна теряться молча — `dial`
    // ловит всё и пишет итог; сюда долетит лишь сбой записи итога, его видно в логе.
    void this.dial(row.id, esl, endpoint).catch((cause: unknown) => {
      this.logger.error('Итог тестового звонка не записан', cause, { test_call_id: row.id });
    });

    return row;
  }

  /** Проба с итогом, видимым человеку. Чужая для партнёра — «не найдена». */
  async get(id: TestCallId, partnerId?: Id<'partner'>): Promise<TestCallRow> {
    const row = await this.repository.find(id);
    if (row === undefined || (partnerId !== undefined && row.partnerId !== partnerId)) {
      throw notFound('Тестовый звонок не найден');
    }
    return row;
  }

  /**
   * Итог по CDR ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md), §3).
   *
   * Узел присылает CDR и по пробе. Из него берутся длительность разговора и код SIP,
   * а если процесс площадки перезапустился посреди звонка — и сам итог.
   */
  async acceptCdr(id: TestCallId, cdr: ParsedCdr): Promise<void> {
    const status = statusFromHangupCause(cdr.hangupCause, cdr.billableSeconds);
    await this.repository.finish(id, {
      status: testStatusOf(status === 'completed' ? 'answered' : status),
      hangupCause: cdr.hangupCause,
      sipStatus: cdr.sipStatus ?? null,
      sipPhrase: cdr.sipPhrase ?? null,
      rangAt: cdr.progressAt ?? null,
      talkSeconds: cdr.billableSeconds,
    });
  }

  private async dial(id: TestCallId, esl: EslTarget, endpoint: string): Promise<void> {
    const variables = [
      `origination_uuid=${id}`,
      `zvonix_test_call=${id}`,
      `originate_timeout=${String(ORIGINATE_TIMEOUT_SECONDS)}`,
      // Гудки и «абонент недоступен» из сети — ранние медиа; ответом их не считаем.
      'ignore_early_media=true',
    ].join(',');
    const command = `originate {${variables}}${endpoint} &playback(${TEST_TONE})`;

    let reply: string;
    try {
      reply = await eslApi(esl, command, { timeoutMs: ESL_COMMAND_TIMEOUT_MS });
    } catch (cause) {
      const failure = cause instanceof EslError ? cause.failure : 'protocol';
      this.logger.warn('Узел не принял команду тестового звонка', {
        test_call_id: id,
        failure,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      // Срок истёк — итог мог наступить на узле; его допишет CDR, если он придёт.
      if (failure === 'timeout') return;
      await this.repository.finish(id, {
        status: 'failed',
        hangupCause: `ESL_${failure.toUpperCase()}`,
      });
      return;
    }

    const outcome = parseOriginateReply(reply);
    this.logger.info('Тестовый звонок завершён', {
      test_call_id: id,
      status: outcome.status,
      hangup_cause: outcome.hangupCause,
    });
    await this.repository.finish(id, outcome);
  }
}

/**
 * Ответ `api originate`: `+OK <uuid>` — ответили; `-ERR <ПРИЧИНА>` — причина отбоя
 * FreeSWITCH. Всё прочее — непонятый ответ, итог `failed` с ним самим, обрезанным.
 */
export function parseOriginateReply(reply: string): {
  status: Exclude<TestCallStatus, 'dialing'>;
  hangupCause: string | null;
} {
  if (reply.startsWith('+OK')) return { status: 'answered', hangupCause: null };
  const cause = /^-ERR\s+([A-Z_]+)/.exec(reply)?.[1];
  if (cause === undefined) {
    return { status: 'failed', hangupCause: `UNEXPECTED_REPLY: ${reply.slice(0, 80)}` };
  }
  return { status: testStatusOf(statusFromHangupCause(cause, 0)), hangupCause: cause };
}

/** Итог вызова в итог пробы: у пробы нет «отменено» и «идёт» — это отказ. */
function testStatusOf(status: string): Exclude<TestCallStatus, 'dialing'> {
  switch (status) {
    case 'answered':
    case 'busy':
    case 'no_answer':
      return status;
    default:
      return 'failed';
  }
}
