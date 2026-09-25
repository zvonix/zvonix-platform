/**
 * Реестр узлов АТС и их подключение (ADR-0009, ADR-0019).
 *
 * Порядок из ARCHITECTURE.md: администратор заводит узел в панели → система выдаёт
 * одноразовый токен и команду установки → скрипт применяет токен и получает постоянный
 * ключ → агент шлёт heartbeat. Отсюда и первое состояние `provisioned`: запись есть,
 * узел ещё не отвечает.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  notFound,
  NODE_OFFLINE_AFTER_MS,
  parseId,
  type Id,
  type NodeStatus,
  type UserRole,
} from '@zvonix/shared';
import type { EslTarget } from '../../infra/esl.js';
import { decryptSecret, encryptSecret, NODE_ESL_SECRET_PURPOSE } from '../../infra/secret-box.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { MachineService, type MachinePrincipal } from '../machine/machine.service.js';
import { NodesRepository, type NodeId, type NodeRow } from './nodes.repository.js';

/** Узел вместе с командой, которую администратор скопирует на сервер. */
export interface ProvisionedNode {
  readonly node: NodeRow;
  readonly installCommand: string;
  readonly tokenExpiresAt: Date | null;
}

/** Что скрипт установки получает в обмен на одноразовый токен. */
export interface NodeEnrollment {
  readonly node: NodeRow;
  readonly keyId: string;
  readonly secret: string;
  readonly endpoints: Readonly<Record<string, string>>;
}

/**
 * Где слушает ESL узла на той же машине (ADR-0051: только петлевой адрес, порт штатный).
 * Адрес от узла не принимается — см. `registerEsl`.
 */
const LOCAL_ESL_HOST = '127.0.0.1';
const LOCAL_ESL_PORT = 8021;

/** Адрес, с которого запрос пришёл изнутри машины. */
function isLoopback(ip: string | undefined): boolean {
  if (ip === undefined) return false;
  const bare = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

export interface HeartbeatInput {
  readonly activeCalls: number;
  readonly agentVersion: string | null;
  readonly degraded: boolean;
}

@Injectable()
export class NodesService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: NodesRepository,
    private readonly machine: MachineService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('nodes');
  }

  /**
   * Заводит узел и выдаёт команду установки.
   *
   * В команде — **одноразовый** токен, а не постоянный ключ: команда попадает в историю
   * оболочки, в переписку и в буфер обмена (ADR-0019).
   */
  async provision(
    input: { name: string; sipAddress: string | null; allowedIps: readonly string[] },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<ProvisionedNode> {
    const node = await this.repository.create({ name: input.name, sipAddress: input.sipAddress });

    await this.audit.record({
      action: 'node.provisioned',
      entityType: 'node',
      entityId: node.id,
      actorUserId,
      actorRole,
      after: { name: node.name, sip_address: node.sipAddress },
    });

    return this.issueInstallCommand(node, input.allowedIps, actorUserId, actorRole);
  }

  /**
   * Выдаёт новую команду установки для существующего узла.
   *
   * Нужна, когда прежний токен истёк или был применён: срок у него час, а установка
   * откладывается на завтра чаще, чем хотелось бы.
   */
  async reissueInstallCommand(
    id: NodeId,
    allowedIps: readonly string[],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<ProvisionedNode> {
    const node = await this.require(id);
    if (node.status === 'decommissioned') {
      throw conflict('Узел выведен из эксплуатации');
    }
    return this.issueInstallCommand(node, allowedIps, actorUserId, actorRole);
  }

  private async issueInstallCommand(
    node: NodeRow,
    allowedIps: readonly string[],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<ProvisionedNode> {
    const issued = await this.machine.issue({
      kind: 'enrollment',
      ownerId: node.id,
      label: `Установка узла «${node.name}»`,
      allowedIps,
      actorUserId,
      actorRole,
    });

    const base = this.config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    return {
      node,
      installCommand: `curl -fsSL ${base}/install.sh | sudo bash -s -- ${issued.keyId}.${issued.secret}`,
      tokenExpiresAt: issued.expiresAt,
    };
  }

  /**
   * Обменивает одноразовый токен на постоянный ключ узла.
   *
   * Ключ к этому моменту уже проверен защитником; здесь токен помечается применённым
   * и выпускается рабочий. Порядок именно такой: сначала расход токена, потом выпуск.
   * Обратный оставлял бы выпущенный ключ при неудавшемся расходе — то есть рабочий
   * ключ у того, кто применил токен вторым.
   */
  async enroll(
    principal: MachinePrincipal,
    hostname: string,
    agentVersion: string | null,
    ip: string | undefined,
  ): Promise<NodeEnrollment> {
    const nodeId = parseId(principal.ownerId, 'node');
    const node = await this.repository.findById(nodeId);
    if (node === undefined) {
      // Узел удалили после выдачи токена. Токен при этом остаётся действующим,
      // поэтому расходуем его: иначе он живёт до истечения срока.
      await this.machine.consumeEnrollment(principal.credentialId, ip);
      throw notFound('Узел не найден');
    }

    await this.machine.consumeEnrollment(principal.credentialId, ip);

    const registered = await this.repository.markInstalling(nodeId, hostname, agentVersion);
    if (registered === undefined) throw notFound('Узел не найден');

    const issued = await this.machine.issue({
      kind: 'node',
      ownerId: nodeId,
      // Адрес узла на момент установки известен точно — это адрес, с которого он пришёл.
      // Ограничение по адресу и есть то, что делает украденный с узла ключ бесполезным.
      allowedIps: ip === undefined ? [] : [ip],
      label: `Ключ узла «${node.name}» от ${new Date().toISOString().slice(0, 10)}`,
      // Выпускает машина, а не человек: узел применил токен установки сам.
      // Приписывать это администратору значило бы соврать журналу.
      actorUserId: null,
      actorRole: null,
    });

    await this.audit.record({
      action: 'node.enrolled',
      entityType: 'node',
      entityId: nodeId,
      ip: ip ?? null,
      after: { hostname, agent_version: agentVersion, key_id: issued.keyId },
    });

    this.logger.info('Узел зарегистрирован', {
      node_id: nodeId,
      hostname,
      key_id: issued.keyId,
    });

    const base = this.config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    return {
      node: registered,
      keyId: issued.keyId,
      secret: issued.secret,
      endpoints: {
        directory: `${base}/node/directory`,
        dialplan: `${base}/node/dialplan`,
        cdr: `${base}/node/cdr`,
        heartbeat: `${base}/node/heartbeat`,
      },
    };
  }

  /**
   * Принимает heartbeat от агента.
   *
   * Узел сам сообщает, считает ли себя ослабленным: часть шлюзов не зарегистрирована,
   * нагрузка выше порога. Решение «жив или нет» при этом остаётся за control plane —
   * молчание переводит узел в `offline` независимо от того, что он присылал раньше.
   */
  async heartbeat(principal: MachinePrincipal, input: HeartbeatInput): Promise<NodeRow> {
    const nodeId = parseId(principal.ownerId, 'node');
    const status: NodeStatus = input.degraded ? 'degraded' : 'online';
    const updated = await this.repository.recordHeartbeat(nodeId, {
      status,
      activeCalls: input.activeCalls,
      agentVersion: input.agentVersion,
      at: new Date(),
    });
    if (updated === undefined) throw notFound('Узел не найден');
    return updated;
  }

  /**
   * Принимает пароль ESL от узла ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
   *
   * **Только с петлевого адреса.** ESL узла слушает 127.0.0.1 (ADR-0051), и достучаться
   * до него площадка может, лишь стоя на той же машине. Запрос с петлевого адреса
   * и доказывает это: чужая машина его не пришлёт — за nginx адрес берётся из
   * `X-Forwarded-For` доверенного прокси, а не из заголовка клиента.
   *
   * Пароль хранится зашифрованным: с ним площадка может звонить, и утечка одной базы
   * этого давать не должна.
   */
  async registerEsl(
    principal: MachinePrincipal,
    password: string,
    ip: string | undefined,
  ): Promise<NodeRow> {
    const nodeId = parseId(principal.ownerId, 'node');
    if (!isLoopback(ip)) {
      throw conflict(
        'Площадка звонит только через узел на своей же машине: ESL узла закрыт для внешних адресов',
        { details: { reason: 'esl_not_local' } },
      );
    }

    const updated = await this.repository.setEslSecret(
      nodeId,
      encryptSecret(password, this.config.SECRET_KEY, NODE_ESL_SECRET_PURPOSE),
    );
    if (updated === undefined) throw notFound('Узел не найден');

    // Пароль в журнал не пишется ни в каком виде — только сам факт.
    await this.audit.record({
      action: 'node.esl_registered',
      entityType: 'node',
      entityId: nodeId,
      ip: ip ?? null,
      after: { esl_host: LOCAL_ESL_HOST, esl_port: LOCAL_ESL_PORT },
    });
    this.logger.info('Узел сообщил пароль ESL', { node_id: nodeId });
    return updated;
  }

  /**
   * Куда отдавать команды узлу. `undefined` — узел пароль не сообщал или выведен:
   * звонить с него площадка не может.
   */
  async eslTargetOf(id: NodeId): Promise<EslTarget | undefined> {
    const node = await this.repository.findById(id);
    if (node === undefined || node.eslSecret === null || node.status === 'decommissioned') {
      return undefined;
    }
    return {
      host: LOCAL_ESL_HOST,
      port: LOCAL_ESL_PORT,
      // Не расшифровался — ключ площадки сменили или запись испорчена. Ошибка
      // не проглатывается: молча ответить «пароля нет» значило бы спрятать поломку.
      password: decryptSecret(node.eslSecret, this.config.SECRET_KEY, NODE_ESL_SECRET_PURPOSE),
    };
  }

  /**
   * Снимает с маршрутизации узлы, замолчавшие дольше порога.
   *
   * Вызывается фоновой задачей. Пока её нет, вызывается при запросе списка узлов —
   * иначе в панели висел бы `online` у машины, выключенной неделю назад.
   */
  async retireSilent(now: Date = new Date()): Promise<NodeId[]> {
    const deadline = new Date(now.getTime() - NODE_OFFLINE_AFTER_MS);
    const retired = await this.repository.markSilentOffline(deadline);
    if (retired.length > 0) {
      this.logger.warn('Узлы замолчали и сняты с маршрутизации', {
        node_ids: retired,
        silent_for_ms: NODE_OFFLINE_AFTER_MS,
      });
    }
    return retired;
  }

  async list(): Promise<NodeRow[]> {
    await this.retireSilent();
    return this.repository.list();
  }

  async get(id: NodeId): Promise<NodeRow> {
    return this.require(id);
  }

  /**
   * Выводит узел из эксплуатации: отзывает все его ключи и закрывает запись.
   *
   * Запись остаётся: на узел ссылаются CDR, а их не удаляют никогда.
   */
  async decommission(id: NodeId, actorUserId: Id<'user'>, actorRole: UserRole): Promise<NodeRow> {
    const node = await this.require(id);
    if (node.status === 'decommissioned') return node;

    const revoked = await this.machine.revokeAllOf(id, actorUserId, actorRole);
    const closed = await this.repository.setStatus(id, 'decommissioned');
    if (closed === undefined) throw notFound('Узел не найден');

    await this.audit.record({
      action: 'node.decommissioned',
      entityType: 'node',
      entityId: id,
      actorUserId,
      actorRole,
      before: { status: node.status },
      after: { status: 'decommissioned', revoked_keys: revoked },
    });

    return closed;
  }

  private async require(id: NodeId): Promise<NodeRow> {
    const node = await this.repository.findById(id);
    if (node === undefined) throw notFound('Узел не найден');
    return node;
  }
}
