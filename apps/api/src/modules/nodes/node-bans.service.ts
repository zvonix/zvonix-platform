/**
 * Блокировки fail2ban узла — видно и снять из кабинета ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md)).
 *
 * Список и снятие идут через службу команд узла (ADR-0115), как проверка связи с провайдером: скрипты
 * `zvonix-bans` и `zvonix-unban` ставит `node/install.sh`. Здесь — постановка команды, разбор ответа и журнал.
 * Адрес снятия проверяется до постановки команды (схема API и `isIP` ниже), а скрипт узла проверяет его ещё раз.
 */

import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { notFound, validationFailed, type Id, type UserRole } from '@zvonix/shared';
import { EslError } from '../../infra/esl.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { NodeCommandsService } from './node-commands.service.js';
import { NodesRepository, type NodeId } from './nodes.repository.js';

/** Список читается за секунды; запас — на очередь команд и доставку ответа. */
const BANS_TIMEOUT_MS = 30_000;

const SUMMARY_PREFIX = 'ИТОГ: ';

/** Тюрьмы узла: короткие коды из ответа `zvonix-bans` → имя в API. */
const JAILS = {
  f: 'sip_foreign',
  k: 'sip_known',
  s: 'ssh',
} as const;

export type BanJail = (typeof JAILS)[keyof typeof JAILS];

interface NodeBan {
  readonly jail: BanJail;
  readonly address: string;
  /** До какого момента; `null` — узел срок не сообщил (старый fail2ban). */
  readonly until: Date | null;
}

export interface NodeBans {
  /** Удалось ли получить список; нет — `message` говорит почему. */
  readonly available: boolean;
  readonly message: string | null;
  readonly bans: readonly NodeBan[];
  /** Сколько блокировок на узле по его итогу; больше, чем в `bans`, — ответ обрезан. */
  readonly total: number;
}

/** Узел на машине площадки получает команды по ESL, где скриптов узла нет, — как у проверки связи. */
const OLD_NODE =
  'Узел ещё не обновился и не умеет показывать блокировки — подождите несколько минут после обновления';

function failureMessage(error: EslError): string {
  return error.failure === 'timeout'
    ? 'Узел не ответил вовремя — повторите через минуту'
    : 'Узел АТС сейчас не принимает команды — проверьте, на связи ли он';
}

/** Ответ `zvonix-bans`: итог первой строкой, дальше «код адрес до» на строку. */
export function parseBans(reply: string): NodeBans {
  const text = reply.trim();
  if (text.startsWith('-ERR')) return { available: false, message: OLD_NODE, bans: [], total: 0 };
  const [first = '', ...rest] = text.split('\n');
  if (!first.startsWith(SUMMARY_PREFIX)) {
    return { available: false, message: 'Узел прислал непонятный ответ', bans: [], total: 0 };
  }
  const counted = /блокировок (\d+)/u.exec(first);
  const bans: NodeBan[] = [];
  for (const line of rest) {
    const [code = '', address = '', until = ''] = line.trim().split(/\s+/u);
    const jail = JAILS[code as keyof typeof JAILS] as BanJail | undefined;
    if (jail === undefined || isIP(address) === 0) continue;
    const seconds = Number(until);
    bans.push({
      jail,
      address,
      until: /^\d+$/u.test(until) && seconds > 0 ? new Date(seconds * 1000) : null,
    });
  }
  return {
    // Итог без числа — узел сообщил причину («fail2ban не установлен»): покажем её как есть.
    available: counted !== null,
    message: counted === null ? first.slice(SUMMARY_PREFIX.length).trim() : null,
    bans,
    total: counted === null ? 0 : Number(counted[1]),
  };
}

@Injectable()
export class NodeBansService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: NodesRepository,
    private readonly commands: NodeCommandsService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('node-bans');
  }

  async list(nodeId: NodeId): Promise<NodeBans> {
    await this.requireNode(nodeId);
    try {
      return parseBans(await this.commands.run(nodeId, 'zvonix-bans', BANS_TIMEOUT_MS));
    } catch (error) {
      if (!(error instanceof EslError)) throw error;
      this.logger.warn('Список блокировок узла не получен', {
        node_id: nodeId,
        failure: error.failure,
      });
      return { available: false, message: failureMessage(error), bans: [], total: 0 };
    }
  }

  /** Снять блокировку одного адреса во всех тюрьмах узла; каждое снятие — в журнале. */
  async unban(
    nodeId: NodeId,
    address: string,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ removed: boolean; message: string }> {
    // Схема API уже проверила адрес; здесь ещё раз — команда уходит на сервер в строке shell.
    if (isIP(address) === 0) {
      throw validationFailed('Неверный адрес', { details: { field: 'address' } });
    }
    await this.requireNode(nodeId);
    let reply: string;
    try {
      reply = await this.commands.run(nodeId, `zvonix-unban ${address}`, BANS_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof EslError)) throw error;
      return { removed: false, message: failureMessage(error) };
    }
    const text = reply.trim();
    if (text.startsWith('-ERR')) return { removed: false, message: OLD_NODE };
    const [first = '', ...rest] = text.split('\n');
    const summary = first.startsWith(SUMMARY_PREFIX)
      ? first.slice(SUMMARY_PREFIX.length).trim()
      : 'Узел прислал непонятный ответ';
    const removed = summary === 'блокировка снята';
    const jails = rest
      .join(' ')
      .replace(/^Тюрьмы:\s*/u, '')
      .split(/\s+/u)
      .filter((jail) => jail !== '');
    await this.audit.record({
      action: 'node.ban_removed',
      entityType: 'node',
      entityId: nodeId,
      actorUserId,
      actorRole,
      before: { address, jails },
      after: { removed, summary },
    });
    this.logger.info('Снятие блокировки на узле', { node_id: nodeId, removed });
    return { removed, message: summary };
  }

  private async requireNode(nodeId: NodeId): Promise<void> {
    const node = await this.repository.findById(nodeId);
    if (node === undefined) throw notFound('Узел не найден');
  }
}
