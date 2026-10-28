/**
 * Подключена ли программа клиента к линии — по регистрациям на узлах
 * ([ADR-0101](../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md), п. 1–3).
 *
 * Отметка запроса учётной записи, как у шлюзов, здесь не годится: узел спрашивает запись и у программы со старым паролем.
 * Регистрация на узле появляется только после верного пароля — поэтому опрос, а не отметка.
 */

import { Inject, Injectable } from '@nestjs/common';
import { isSipUsername } from '@zvonix/shared';
import { EslError, eslApi } from '../../infra/esl.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { NodesService } from '../nodes/nodes.service.js';
import type { NodeId } from '../nodes/nodes.repository.js';
import { TelephonyRepository, type ChannelRow } from './telephony.repository.js';

/** Профиль SIP узла (`node/conf/autoload_configs/sofia.conf.xml`). */
const SOFIA_PROFILE = 'zvonix';

/** Ответ на `show registrations` — строка, а не выгрузка; дольше — узел занят, подождём следующего прохода. */
const ESL_TIMEOUT_MS = 5_000;

/**
 * Сколько отметка опроса считается свежей. Опрос — раз в минуту; три прохода подряд без линии — узел молчит или
 * программа отключилась, и «подключена» было бы неправдой.
 */
export const CHANNEL_REGISTRATION_FRESH_MS = 3 * 60_000;

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
 * чужая запись не должна гасить отметку остальным линиям. Ответ, который не JSON (`-ERR …`), — ошибка узла.
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

/** Подключена ли линия сейчас: регистрация не истекла, и опрос видел её недавно. */
export function isChannelConnected(row: ChannelRow, now: Date): boolean {
  return (
    row.registrationExpiresAt !== null &&
    row.registrationSeenAt !== null &&
    row.registrationExpiresAt.getTime() > now.getTime() &&
    now.getTime() - row.registrationSeenAt.getTime() <= CHANNEL_REGISTRATION_FRESH_MS
  );
}

@Injectable()
export class ChannelRegistrationsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: TelephonyRepository,
    private readonly nodes: NodesService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('channel-registrations');
  }

  /**
   * Проход опроса: у каждого узла с ESL — его регистрации линий. Возвращает, сколько линий отмечено.
   *
   * Узел не ответил — отметки его линий просто не обновятся и через `CHANNEL_REGISTRATION_FRESH_MS` погаснут: линия
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
      const lines = registrations.filter(
        (entry) =>
          entry.realm.toLowerCase() === realm &&
          entry.username.startsWith('ch-') &&
          isSipUsername(entry.username),
      );
      recorded += await this.repository.recordChannelRegistrations(node, lines, now);
    }
    return recorded;
  }

  /**
   * Сбросить регистрацию линии на узлах и отметку в базе (ADR-0101, п. 3): сменился пароль, линию выключили или удалили.
   *
   * Узел не ответил — предупреждение, а не отказ: действие клиента уже состоялось, а регистрация всё равно истечёт,
   * и новый пароль её не продлит.
   */
  async flush(channel: ChannelRow): Promise<void> {
    await this.repository.clearChannelRegistration(channel.id);
    if (!isSipUsername(channel.sipUsername)) return;
    const command = `sofia profile ${SOFIA_PROFILE} flush_inbound_reg ${channel.sipUsername}@${this.config.SIP_REALM}`;
    for (const node of await this.liveNodes()) {
      try {
        const target = await this.nodes.eslTargetOf(node);
        if (target === undefined) continue;
        const reply = await eslApi(target, command, { timeoutMs: ESL_TIMEOUT_MS });
        if (reply.trim().startsWith('-ERR')) {
          this.logger.warn('Узел не сбросил регистрацию линии', {
            node_id: node,
            channel_id: channel.id,
            reply: reply.trim().slice(0, 120),
          });
        }
      } catch (cause) {
        this.logger.warn('Узел не сбросил регистрацию линии', {
          node_id: node,
          channel_id: channel.id,
          failure: cause instanceof EslError ? cause.failure : 'unknown',
        });
      }
    }
  }

  private async liveNodes(): Promise<NodeId[]> {
    const rows = await this.nodes.list();
    return rows.filter((row) => row.status !== 'decommissioned').map((row) => row.id);
  }
}
