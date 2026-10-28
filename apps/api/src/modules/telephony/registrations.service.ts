/**
 * Подключено ли устройство к узлу — по регистрациям на узлах: программа клиента на линии
 * ([ADR-0101](../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md), п. 1–3), шлюз партнёра
 * и линия GOIP ([ADR-0103](../../../../../docs/adr/0103-shlyuz-na-svyazi-po-oprosu-i-trevoga-partnyoru.md)).
 *
 * Отметка запроса учётной записи здесь не годится: узел спрашивает запись и у устройства со старым паролем.
 * Регистрация на узле появляется только после верного пароля — поэтому опрос, а не отметка.
 */

import { Inject, Injectable } from '@nestjs/common';
import { isSipUsername } from '@zvonix/shared';
import { EslError, eslApi, type EslTarget } from '../../infra/esl.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { NodesService } from '../nodes/nodes.service.js';
import type { NodeId } from '../nodes/nodes.repository.js';
import { TelephonyRepository, type ChannelRow } from './telephony.repository.js';

/** Профиль SIP узла (`node/conf/autoload_configs/sofia.conf.xml`). */
const SOFIA_PROFILE = 'zvonix';

/** Ответ на `show registrations` — строка, а не выгрузка; дольше — узел занят, подождём следующего прохода. */
const ESL_TIMEOUT_MS = 5_000;

/**
 * Сколько отметка опроса считается свежей. Опрос — раз в минуту; три прохода подряд без устройства — узел молчит или
 * устройство отключилось, и «подключено» было бы неправдой.
 */
export const REGISTRATION_FRESH_MS = 3 * 60_000;

/**
 * Сколько запрос учётной записи считается недавним. Не вошедшее устройство повторяет попытку каждые несколько десятков
 * секунд, вошедшее — раз в срок регистрации: запрос в последние 10 минут без регистрации — «стучится, но не вошло».
 */
export const KNOCK_RECENT_MS = 10 * 60_000;

export interface NodeRegistration {
  readonly username: string;
  readonly realm: string;
  readonly expiresAt: Date;
  /** `адрес:порт/транспорт`. */
  readonly address: string;
}

/**
 * Разбор ответа `show registrations as json`.
 *
 * Пустой список у FreeSWITCH — `{"row_count":0}`, без `rows`. Строка, которую не разобрать, отбрасывается: одна
 * чужая запись не должна гасить отметку остальным устройствам. Ответ, который не JSON (`-ERR …`), — ошибка узла.
 */
export function parseRegistrations(body: string): NodeRegistration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch (cause) {
    throw new Error(`Узел ответил не JSON: ${body.trim().slice(0, 80)}`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Узел ответил не объектом');
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error('Поле rows — не список');

  const found: NodeRegistration[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const field = (name: string): string => {
      const value = (row as Record<string, unknown>)[name];
      return typeof value === 'string' ? value : '';
    };
    const expires = Number(field('expires'));
    if (field('reg_user') === '' || !Number.isFinite(expires) || expires <= 0) continue;
    const ip = field('network_ip');
    const port = field('network_port');
    const proto = field('network_proto');
    found.push({
      username: field('reg_user'),
      realm: field('realm'),
      expiresAt: new Date(expires * 1000),
      address: `${ip}${port === '' ? '' : `:${port}`}${proto === '' ? '' : `/${proto}`}`,
    });
  }
  return found;
}

/** Отметки опроса — одни у канала, шлюза и линии GOIP. */
export interface RegistrationMarks {
  readonly registrationSeenAt: Date | null;
  readonly registrationExpiresAt: Date | null;
}

/** Подключено ли устройство сейчас: регистрация не истекла, и опрос видел её недавно. */
export function isRegistered(row: RegistrationMarks, now: Date): boolean {
  return (
    row.registrationExpiresAt !== null &&
    row.registrationSeenAt !== null &&
    row.registrationExpiresAt.getTime() > now.getTime() &&
    now.getTime() - row.registrationSeenAt.getTime() <= REGISTRATION_FRESH_MS
  );
}

/** Подключение шлюза или линии GOIP так, как его видят партнёр и администратор (ADR-0103, п. 3). */
export interface DeviceConnectionView {
  readonly connected: boolean;
  /** Когда опрос видел регистрацию последний раз. */
  readonly seen_at: string | null;
  /** Откуда устройство зарегистрировалось, `адрес:порт/транспорт`; только пока подключено. */
  readonly address: string | null;
  /** Когда узел последний раз запрашивал учётную запись — у устройства с неверным паролем тоже. */
  readonly knocked_at: string | null;
  /** Не подключено, но стучалось недавно — скорее всего, неверный пароль. */
  readonly rejected: boolean;
}

export function deviceConnection(
  row: RegistrationMarks & {
    readonly registrationAddress: string | null;
    readonly registeredAt: Date | null;
  },
  now: Date,
): DeviceConnectionView {
  const connected = isRegistered(row, now);
  return {
    connected,
    seen_at: row.registrationSeenAt?.toISOString() ?? null,
    address: connected ? row.registrationAddress : null,
    knocked_at: row.registeredAt?.toISOString() ?? null,
    rejected:
      !connected &&
      row.registeredAt !== null &&
      now.getTime() - row.registeredAt.getTime() <= KNOCK_RECENT_MS,
  };
}

type Owner = 'ch' | 'gw' | 'pt';

/** Чьи регистрации — по префиксу имени (`isSipUsername`): линия клиента, шлюз, линия GOIP. */
function byOwner(entries: readonly NodeRegistration[]): Record<Owner, NodeRegistration[]> {
  const found: Record<Owner, NodeRegistration[]> = { ch: [], gw: [], pt: [] };
  for (const entry of entries) {
    if (!isSipUsername(entry.username)) continue;
    found[entry.username.slice(0, 2) as Owner].push(entry);
  }
  return found;
}

@Injectable()
export class RegistrationsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: TelephonyRepository,
    private readonly nodes: NodesService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('registrations');
  }

  /**
   * Проход опроса: у каждого узла с ESL — его регистрации, одной командой на узел. Возвращает, сколько линий клиентов,
   * шлюзов и линий GOIP отмечено.
   *
   * Узел не ответил — отметки его устройств просто не обновятся и через `REGISTRATION_FRESH_MS` погаснут: устройство
   * через молчащий узел действительно не звонит. Остальные узлы опрашиваются дальше.
   */
  async poll(now: Date): Promise<number> {
    const realm = this.config.SIP_REALM.toLowerCase();
    let recorded = 0;
    for (const node of await this.liveNodes()) {
      let registrations: NodeRegistration[];
      try {
        const target = await this.nodes.eslTargetOf(node);
        if (target === undefined) continue;
        registrations = parseRegistrations(
          await eslApi(target, 'show registrations as json', { timeoutMs: ESL_TIMEOUT_MS }),
        );
      } catch (cause) {
        this.logger.warn('Регистрации узла не прочитаны', {
          node_id: node,
          failure: cause instanceof EslError ? cause.failure : 'reply',
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      const own = byOwner(registrations.filter((entry) => entry.realm.toLowerCase() === realm));
      recorded += await this.repository.recordChannelRegistrations(node, own.ch, now);
      recorded += await this.repository.recordGatewayRegistrations(own.gw, now);
      recorded += await this.repository.recordPortRegistrations(own.pt, now);
    }
    return recorded;
  }

  /**
   * Сбросить регистрацию линии на узлах и отметку в базе (ADR-0101, п. 3): сменился пароль, линию выключили или удалили.
   */
  async flush(channel: ChannelRow): Promise<void> {
    await this.repository.clearChannelRegistration(channel.id);
    await this.flushOnNodes([channel.sipUsername]);
  }

  /**
   * Сбросить регистрации учётных записей на всех узлах — после нового пароля шлюза или линии GOIP (ADR-0103, п. 4).
   * Отметку в базе стирает та же запись, что меняет пароль.
   *
   * Узел не ответил — предупреждение, а не отказ: действие уже состоялось, а регистрация всё равно истечёт,
   * и новый пароль её не продлит.
   */
  async flushOnNodes(usernames: readonly string[]): Promise<void> {
    const names = usernames.filter(isSipUsername);
    if (names.length === 0) return;
    for (const node of await this.liveNodes()) {
      let target: EslTarget | undefined;
      try {
        target = await this.nodes.eslTargetOf(node);
      } catch (cause) {
        this.logger.warn('Узел не сбросил регистрацию', {
          node_id: node,
          failure: cause instanceof EslError ? cause.failure : 'unknown',
        });
        continue;
      }
      if (target === undefined) continue;
      for (const username of names) {
        const command = `sofia profile ${SOFIA_PROFILE} flush_inbound_reg ${username}@${this.config.SIP_REALM}`;
        try {
          const reply = await eslApi(target, command, { timeoutMs: ESL_TIMEOUT_MS });
          if (reply.trim().startsWith('-ERR')) {
            this.logger.warn('Узел не сбросил регистрацию', {
              node_id: node,
              username,
              reply: reply.trim().slice(0, 120),
            });
          }
        } catch (cause) {
          this.logger.warn('Узел не сбросил регистрацию', {
            node_id: node,
            username,
            failure: cause instanceof EslError ? cause.failure : 'unknown',
          });
        }
      }
    }
  }

  private async liveNodes(): Promise<NodeId[]> {
    const rows = await this.nodes.list();
    return rows.filter((row) => row.status !== 'decommissioned').map((row) => row.id);
  }
}
