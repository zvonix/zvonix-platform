/**
 * Команды узлу АТС ([ADR-0115](../../../../../docs/adr/0115-uzel-zabiraet-komandy.md)).
 *
 * Одна дверь для вызывающих — тестового звонка и сброса регистрации. Узел на машине площадки получает команду
 * по ESL, как прежде (ADR-0055). Узел на отдельной машине ESL наружу не открывает: его служба команд держит
 * долгий запрос `GET /node/commands`, забирает команду из очереди `node_commands`, выполняет и присылает ответ.
 *
 * Ошибки — `EslError` с теми же видами, что у ESL: вызывающим не важно, каким путём ушла команда.
 * `connect` — узел команду не получил (звонка не было), `timeout` — получил, но ответ не пришёл вовремя.
 */

import { Inject, Injectable } from '@nestjs/common';
import { notFound, parseId } from '@zvonix/shared';
import { EslError, eslApi } from '../../infra/esl.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { NodesRepository, type NodeCommandId, type NodeId } from './nodes.repository.js';
import { NodesService } from './nodes.service.js';

/** Сколько узел может не брать команду. Служба забирает её за секунду; дольше — службы нет или узел молчит. */
const TAKE_WITHIN_MS = 10_000;

/** Как давно служба команд должна была спросить команды, чтобы узел считался готовым их брать. */
const POLLED_RECENTLY_MS = 90_000;

/** Сколько держится долгий запрос узла. Меньше срока прокси (60 с) и `--max-time` службы на узле (40 с). */
const LONG_POLL_MS = 25_000;

/** Как часто долгий запрос заглядывает в очередь и ожидающий — за ответом. */
const CHECK_EVERY_MS = 500;

/** Сутки: в команде звонка номер абонента, дольше держать незачем. */
const KEEP_COMMANDS_MS = 24 * 60 * 60_000;

/** Что забирает узел: идентификатор и строка `api`. */
export interface TakenCommand {
  readonly id: NodeCommandId;
  readonly command: string;
}

@Injectable()
export class NodeCommandsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: NodesRepository,
    private readonly nodes: NodesService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('node-commands');
  }

  /** Можно ли отдать узлу команду сейчас: ESL своей машины или служба команд спрашивала недавно. */
  async available(nodeId: NodeId, now: Date = new Date()): Promise<boolean> {
    if ((await this.nodes.eslTargetOf(nodeId)) !== undefined) return true;
    const node = await this.repository.findById(nodeId);
    return (
      node !== undefined &&
      node.status !== 'decommissioned' &&
      node.commandsPolledAt !== null &&
      now.getTime() - node.commandsPolledAt.getTime() <= POLLED_RECENTLY_MS
    );
  }

  /**
   * Выполнить команду `api` на узле и вернуть ответ FreeSWITCH. `timeoutMs` — на всё, от постановки до ответа.
   * Узлу, который команды не принимает, — `EslError('connect')`.
   */
  async run(nodeId: NodeId, command: string, timeoutMs: number): Promise<string> {
    if (/[\r\n]/u.test(command)) throw new Error('Команда узлу — одна строка');
    const esl = await this.nodes.eslTargetOf(nodeId);
    if (esl !== undefined) return eslApi(esl, command, { timeoutMs });
    if (!(await this.available(nodeId))) {
      throw new EslError('connect', 'Узел не принимает команды: нет ни ESL, ни службы команд');
    }

    const started = Date.now();
    const queued = await this.repository.enqueueCommand(
      nodeId,
      command,
      new Date(started + Math.min(TAKE_WITHIN_MS, timeoutMs)),
    );
    for (;;) {
      await delay(CHECK_EVERY_MS);
      const row = await this.repository.findCommand(queued.id);
      if (row === undefined) throw new EslError('protocol', 'Команда узлу пропала из очереди');
      if (row.finishedAt !== null) return row.reply ?? '';
      const now = Date.now();
      if (row.takenAt === null && now >= row.takeBefore.getTime()) {
        throw new EslError('connect', 'Узел не забрал команду вовремя');
      }
      if (now - started >= timeoutMs) {
        throw new EslError('timeout', 'Узел не ответил на команду вовремя');
      }
    }
  }

  /**
   * Долгий запрос службы команд: команда, как только появилась, или `undefined` через `LONG_POLL_MS`.
   * `gone` — узел оборвал запрос: команду тогда не брать, иначе она взята, а выполнить её некому.
   */
  async take(
    principal: MachinePrincipal,
    gone: () => boolean,
    waitMs: number = LONG_POLL_MS,
  ): Promise<TakenCommand | undefined> {
    const nodeId = parseId(principal.ownerId, 'node');
    const deadline = Date.now() + waitMs;
    await this.repository.markCommandsPolled(nodeId, new Date());
    for (;;) {
      if (gone()) return undefined;
      const row = await this.repository.claimCommand(nodeId, new Date());
      if (row !== undefined) {
        this.logger.info('Узел забрал команду', { node_id: nodeId, command_id: row.id });
        return { id: row.id, command: row.command };
      }
      if (Date.now() + CHECK_EVERY_MS > deadline) return undefined;
      await delay(CHECK_EVERY_MS);
    }
  }

  /** Ответ узла на взятую команду. Чужая, не взятая или уже выполненная — 404. */
  async finish(principal: MachinePrincipal, rawId: string, reply: string): Promise<void> {
    const nodeId = parseId(principal.ownerId, 'node');
    const id = parseId(rawId, 'nodeCommand');
    const row = await this.repository.finishCommand(nodeId, id, reply, new Date());
    if (row === undefined) throw notFound('Команда не найдена');
  }

  /** Фоновая задача: убрать команды старше суток. Возвращает, сколько убрано. */
  async purge(now: Date): Promise<number> {
    return this.repository.purgeCommands(new Date(now.getTime() - KEEP_COMMANDS_MS));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
