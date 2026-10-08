/**
 * Бот MAX как второй канал сообщений: регистрация бота площадки, подключение клиентов, подписчики, приём событий
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  dependencyUnavailable,
  isDomainError,
  Money,
  normalizeMsisdn,
  notFound,
  validationFailed,
  type Id,
  type MoneyAmount,
} from '@zvonix/shared';
import {
  decryptSecret,
  encryptSecret,
  MESSENGER_TOKEN_PURPOSE,
} from '../../../infra/secret-box.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../../infra/tokens.js';
import { AuditService } from '../../audit/audit.service.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import {
  BOT_PROVIDER,
  BotRecipientRejectedError,
  BotTokenRejectedError,
  type BotProvider,
} from './bot.provider.js';
import {
  BotsRepository,
  type BotConnectionRow,
  type BotId,
  type BotRow,
} from './bots.repository.js';

/** Алфавит кода клиента для ссылки: без похожих знаков, чтобы код можно было продиктовать. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 10;

/** Сколько подключений воркер обрабатывает за проход платы. */
const FEE_BATCH = 200;

/** Тексты бота людям: готовые, с названием службы (настраиваемые — этап 3 ADR-0077). */
const TEXT = {
  askContact: (service: string) =>
    `Служба «${service}» будет присылать вам уведомления в этом чате. Чтобы мы знали, кому писать, нажмите «Поделиться номером».`,
  shareButton: 'Поделиться номером',
  needLink: 'Бот подключается по ссылке, которую вам прислала служба. Откройте эту ссылку ещё раз.',
  thanks: 'Спасибо! Номер подтверждён. Остановить уведомления — напишите СТОП.',
  notYours: 'Поделитесь своим номером кнопкой под сообщением.',
  stopped: 'Уведомления остановлены. Чтобы вернуться, откройте ссылку службы ещё раз.',
  help: 'Этот бот только присылает уведомления службы. Остановить их — напишите СТОП.',
};

/** Событие платформы, как оно приходит на вебхук; лишние поля игнорируются. */
export interface BotUpdate {
  readonly update_type?: string | undefined;
  readonly chat_id?: number | string | undefined;
  readonly user?: { readonly user_id?: number | string | undefined } | undefined;
  readonly payload?: string | undefined;
  readonly message?:
    | {
        readonly sender?: { readonly user_id?: number | string | undefined } | undefined;
        readonly recipient?: { readonly chat_id?: number | string | undefined } | undefined;
        readonly body?:
          | {
              readonly text?: string | undefined;
              readonly attachments?: readonly BotAttachment[] | undefined;
            }
          | undefined;
        readonly attachments?: readonly BotAttachment[] | undefined;
      }
    | undefined;
}

interface BotAttachment {
  readonly type?: string | undefined;
  readonly payload?:
    | {
        readonly vcf_info?: string | undefined;
        readonly max_info?: { readonly user_id?: number | string | undefined } | undefined;
      }
    | undefined;
}

export interface BotClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly enabled: boolean;
  readonly subscribers: number;
  /** Свои условия клиента (`null` — как у всех) и действующие. */
  readonly own: { readonly message_price: string | null; readonly monthly_fee: string | null };
  readonly terms: BotTerms;
  readonly fee_paid: boolean;
}

export interface BotAdminView {
  readonly enabled: boolean;
  readonly bot: {
    readonly name: string;
    readonly username: string;
    readonly status: BotRow['status'];
    readonly last_error: string | null;
    readonly last_checked_at: string | null;
    readonly clients: number;
    readonly subscribers: number;
  } | null;
}

/** Условия клиента: цена сообщения и плата за месяц, рубли строкой. */
interface BotTerms {
  readonly message_price: string;
  readonly monthly_fee: string;
}

export interface BotClientView {
  /** Бот доступен клиенту: продукт включён и бот площадки вписан и работает. */
  readonly available: boolean;
  readonly connection: {
    readonly enabled: boolean;
    readonly link: string;
    /** Плата за этот месяц взята (или её нет): пока `false`, бот клиенту не отправляет. */
    readonly fee_paid: boolean;
  } | null;
  /** Что платит клиент: общие условия площадки или свои, если администратор их задал. */
  readonly terms: BotTerms;
  readonly subscribers: { readonly total: number; readonly with_phone: number };
}

/** Месяц по часам UTC, ГГГГ-ММ: за него берётся ежемесячная плата. */
const periodOf = (now: Date): string => now.toISOString().slice(0, 7);

@Injectable()
export class BotsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: BotsRepository,
    private readonly settings: SettingsService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    @Inject(BOT_PROVIDER) private readonly provider: BotProvider,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('bots');
  }

  // --- Секреты и адреса ---------------------------------------------------------------------------

  /**
   * Секрет вебхука бота. Выводится из `SECRET_KEY` и идентификатора бота: хранить нечего, подобрать нельзя;
   * смена `SECRET_KEY` требует заново нажать «Проверить» у бота — подписка перенастроится.
   */
  webhookSecret(botId: string): string {
    return createHmac('sha256', this.config.SECRET_KEY)
      .update(`zvonix:max-bot-webhook:v1:${botId}`)
      .digest('hex');
  }

  /** Совпадает ли присланный в заголовке секрет с секретом бота — за постоянное время. */
  secretMatches(botId: string, given: string | undefined): boolean {
    if (given === undefined) return false;
    const expected = Buffer.from(this.webhookSecret(botId));
    const got = Buffer.from(given);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  private webhookUrl(botId: string): string {
    return `${this.config.WEB_BASE_URL.replace(/\/+$/u, '')}/api/webhooks/max-bot/${botId}`;
  }

  private tokenOf(bot: BotRow): string {
    return decryptSecret(bot.token, this.config.SECRET_KEY, MESSENGER_TOKEN_PURPOSE);
  }

  private linkOf(bot: BotRow, code: string): string {
    return `https://max.ru/${bot.username}?start=${code}`;
  }

  // --- Бот площадки (администратор) ------------------------------------------------------------------

  async adminView(): Promise<BotAdminView> {
    const [{ enabled }, bot] = await Promise.all([
      this.settings.bot(),
      this.repository.findPlatformBot(),
    ]);
    if (bot === undefined) return { enabled, bot: null };
    const totals = await this.repository.totals(bot.id);
    return {
      enabled,
      bot: {
        name: bot.name,
        username: bot.username,
        status: bot.status,
        last_error: bot.lastError,
        last_checked_at: bot.lastCheckedAt?.toISOString() ?? null,
        clients: totals.clients,
        subscribers: totals.subscribers,
      },
    };
  }

  /**
   * Вписывает бота площадки: токен проверяется у MAX, вебхук настраивается, и только потом бот сохраняется.
   * Повторная запись заменяет токен у того же бота (смена токена, перевыпуск).
   */
  async registerPlatformBot(actor: Principal, token: string): Promise<BotAdminView> {
    const trimmed = token.trim();
    if (trimmed === '') throw validationFailed('Токен бота не может быть пустым');
    let identity;
    try {
      identity = await this.provider.me(trimmed);
    } catch (cause) {
      if (cause instanceof BotTokenRejectedError) {
        throw validationFailed('MAX не принял токен бота. Проверьте, что скопировали его целиком');
      }
      throw cause;
    }

    const existing = await this.repository.findPlatformBot();
    const id = existing?.id ?? this.repository.newBotId();
    await this.provider.subscribe(trimmed, this.webhookUrl(id), this.webhookSecret(id));
    // Токен сменился на токен другого бота: прежняя подписка старого бота больше не нужна.
    if (existing !== undefined && existing.botUserId !== identity.userId) {
      await this.provider
        .unsubscribe(this.tokenOf(existing), this.webhookUrl(id))
        .catch(() => undefined);
    }

    const saved = await this.repository.savePlatformBot({
      id,
      token: encryptSecret(trimmed, this.config.SECRET_KEY, MESSENGER_TOKEN_PURPOSE),
      botUserId: identity.userId,
      name: identity.name,
      username: identity.username,
    });
    await this.audit.record({
      action: 'messenger_bot.registered',
      entityType: 'messenger_bot',
      entityId: saved.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { kind: 'platform', username: saved.username },
    });
    return this.adminView();
  }

  /** Проверка бота кнопкой: токен принимается, вебхук настроен. Результат — в состоянии бота. */
  async checkPlatformBot(actor: Principal): Promise<BotAdminView> {
    const bot = await this.requirePlatformBot();
    try {
      await this.provider.me(this.tokenOf(bot));
      await this.provider.subscribe(
        this.tokenOf(bot),
        this.webhookUrl(bot.id),
        this.webhookSecret(bot.id),
      );
      await this.repository.setBotState(bot.id, { status: 'active', lastError: null });
    } catch (cause) {
      const text =
        cause instanceof BotTokenRejectedError
          ? 'MAX не принял токен: бот удалён или токен перевыпущен'
          : 'MAX не ответил на проверку';
      await this.repository.setBotState(bot.id, { lastError: text });
    }
    await this.audit.record({
      action: 'messenger_bot.checked',
      entityType: 'messenger_bot',
      entityId: bot.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return this.adminView();
  }

  /** Отключает бота: подписка у MAX снимается, клиентам он перестаёт быть доступен. */
  async disablePlatformBot(actor: Principal): Promise<BotAdminView> {
    const bot = await this.requirePlatformBot();
    await this.provider
      .unsubscribe(this.tokenOf(bot), this.webhookUrl(bot.id))
      .catch((cause: unknown) => {
        this.logger.warn('Подписка бота не снята', {
          reason: cause instanceof Error ? cause.name : 'unknown',
        });
      });
    await this.repository.setBotState(bot.id, { status: 'disabled' });
    await this.audit.record({
      action: 'messenger_bot.disabled',
      entityType: 'messenger_bot',
      entityId: bot.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return this.adminView();
  }

  private async requirePlatformBot(): Promise<BotRow> {
    const bot = await this.repository.findPlatformBot();
    if (bot === undefined) throw notFound('Бот площадки ещё не вписан');
    return bot;
  }

  // --- Клиент ------------------------------------------------------------------------------------

  /** Бот площадки, которым клиент может пользоваться сейчас: продукт включён, бот вписан и работает. */
  private async usablePlatformBot(): Promise<BotRow | undefined> {
    const [{ enabled }, bot] = await Promise.all([
      this.settings.bot(),
      this.repository.findPlatformBot(),
    ]);
    return enabled && bot?.status === 'active' ? bot : undefined;
  }

  /** Условия клиента: свои, если заданы администратором, иначе общие из настроек. */
  private async termsOf(connection: BotConnectionRow | undefined): Promise<{
    messagePrice: MoneyAmount;
    monthlyFee: MoneyAmount;
  }> {
    const settings = await this.settings.bot();
    return {
      messagePrice: connection?.messagePrice ?? settings.messagePrice,
      monthlyFee: connection?.monthlyFee ?? settings.monthlyFee,
    };
  }

  /** Плата взята за этот месяц, либо её нет вовсе. */
  private feePaid(
    connection: BotConnectionRow,
    terms: { monthlyFee: MoneyAmount },
    now: Date,
  ): boolean {
    return Money.isZero(terms.monthlyFee) || connection.feePaidPeriod === periodOf(now);
  }

  async clientView(clientId: Id<'client'>, now: Date = new Date()): Promise<BotClientView> {
    const [bot, connection, subscribers] = await Promise.all([
      this.usablePlatformBot(),
      this.repository.findConnectionByClient(clientId),
      this.repository.countFor(clientId),
    ]);
    const terms = await this.termsOf(connection);
    return {
      available: bot !== undefined,
      connection:
        connection === undefined || bot === undefined
          ? null
          : {
              enabled: connection.enabled,
              link: this.linkOf(bot, connection.code),
              fee_paid: this.feePaid(connection, terms, now),
            },
      terms: {
        message_price: Money.format(terms.messagePrice),
        monthly_fee: Money.format(terms.monthlyFee),
      },
      subscribers: { total: subscribers.total, with_phone: subscribers.withPhone },
    };
  }

  /**
   * Берёт плату за месяц, если она положена и ещё не взята. Не хватило денег — `insufficient` (у биллинга это
   * `409`); любая другая ошибка пробрасывается. Повтор безопасен: ключ проводки — клиент и месяц.
   */
  private async ensureFeePaid(
    connection: BotConnectionRow,
    now: Date,
  ): Promise<'paid' | 'insufficient'> {
    const terms = await this.termsOf(connection);
    const period = periodOf(now);
    if (Money.isZero(terms.monthlyFee) || connection.feePaidPeriod === period) return 'paid';
    try {
      await this.billing.chargeBotFee({
        clientId: connection.clientId,
        period,
        amount: terms.monthlyFee,
      });
    } catch (cause) {
      if (isDomainError(cause) && cause.code === 'conflict') return 'insufficient';
      throw cause;
    }
    await this.repository.markFeePaid(connection.clientId, period);
    return 'paid';
  }

  /** Подключает клиента к боту площадки: берёт плату за месяц, создаёт код и ссылку. Повтор возвращает прежнее. */
  async connect(clientId: Id<'client'>, now: Date = new Date()): Promise<BotClientView> {
    const bot = await this.usablePlatformBot();
    if (bot === undefined) throw conflict('Бот пока недоступен — обратитесь в поддержку');
    const existing = await this.repository.findConnectionByClient(clientId);
    if (existing === undefined) {
      const fee = (await this.settings.bot()).monthlyFee;
      const period = periodOf(now);
      if (!Money.isZero(fee)) {
        try {
          await this.billing.chargeBotFee({ clientId, period, amount: fee });
        } catch (cause) {
          if (isDomainError(cause) && cause.code === 'conflict') {
            throw conflict(`Не хватает денег для платы за бота: ${Money.format(fee)} ₽ в месяц`);
          }
          throw cause;
        }
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = Array.from(
          { length: CODE_LENGTH },
          () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
        ).join('');
        if ((await this.repository.findConnectionByCode(code)) !== undefined) continue;
        await this.repository.insertConnection({
          clientId,
          botId: bot.id,
          code,
          feePaidPeriod: Money.isZero(fee) ? null : period,
        });
        break;
      }
    }
    return this.clientView(clientId, now);
  }

  /** Включает или выключает бота клиента. Включение берёт плату за месяц, если за него ещё не брали. */
  async setEnabled(
    clientId: Id<'client'>,
    enabled: boolean,
    now: Date = new Date(),
  ): Promise<BotClientView> {
    const connection = await this.repository.setConnectionEnabled(clientId, enabled);
    if (connection === undefined) throw notFound('Клиент ещё не подключён к боту');
    if (enabled && (await this.ensureFeePaid(connection, now)) === 'insufficient') {
      await this.repository.setConnectionEnabled(clientId, false);
      throw conflict('Не хватает денег для платы за бота. Пополните счёт и включите снова');
    }
    return this.clientView(clientId, now);
  }

  /**
   * Проход воркера (ADR-0020, догоняющий): берёт плату за текущий месяц у включённых подключений, за которые она ещё
   * не взята. Не хватило денег — подключение остаётся без платы и бот ему не отправляет; следующий проход повторит,
   * и после пополнения счёта плата будет взята сама. Возвращает, у скольких плата взята.
   */
  async chargeFees(now: Date = new Date()): Promise<number> {
    const period = periodOf(now);
    let charged = 0;
    for (const connection of await this.repository.listFeeDue(period, FEE_BATCH)) {
      try {
        if ((await this.ensureFeePaid(connection, now)) === 'paid') {
          // Бесплатное подключение тоже отмечается: проход не вернётся к строке до следующего месяца.
          if (connection.feePaidPeriod !== period) {
            await this.repository.markFeePaid(connection.clientId, period);
          }
          charged += 1;
        }
      } catch (cause) {
        this.logger.error('Плата за бота не взята', cause, { client_id: connection.clientId });
      }
    }
    return charged;
  }

  // --- Администратор: условия клиентов -----------------------------------------------------------

  async adminClients(now: Date = new Date()): Promise<{ clients: BotClientRow[] }> {
    const bot = await this.repository.findPlatformBot();
    if (bot === undefined) return { clients: [] };
    const rows = await this.repository.listConnections(bot.id);
    const clients: BotClientRow[] = [];
    for (const { connection, clientName, subscribers } of rows) {
      const terms = await this.termsOf(connection);
      clients.push({
        client_id: connection.clientId,
        client_name: clientName,
        enabled: connection.enabled,
        subscribers,
        own: {
          message_price:
            connection.messagePrice === null ? null : Money.format(connection.messagePrice),
          monthly_fee: connection.monthlyFee === null ? null : Money.format(connection.monthlyFee),
        },
        terms: {
          message_price: Money.format(terms.messagePrice),
          monthly_fee: Money.format(terms.monthlyFee),
        },
        fee_paid: this.feePaid(connection, terms, now),
      });
    }
    return { clients };
  }

  /**
   * Свои условия клиента: цена сообщения и плата за месяц. `undefined` — не менять, `null` — вернуть к общим.
   * Новая плата действует со следующего месяца: за текущий она уже взята по прежней.
   */
  async setClientTerms(
    actor: Principal,
    clientId: Id<'client'>,
    patch: {
      messagePrice?: MoneyAmount | null | undefined;
      monthlyFee?: MoneyAmount | null | undefined;
    },
  ): Promise<{ clients: BotClientRow[] }> {
    const before = await this.repository.findConnectionByClient(clientId);
    if (before === undefined) throw notFound('Клиент не подключён к боту');
    const after = await this.repository.setConnectionPrices(clientId, {
      ...(patch.messagePrice === undefined ? {} : { messagePrice: patch.messagePrice }),
      ...(patch.monthlyFee === undefined ? {} : { monthlyFee: patch.monthlyFee }),
    });
    const format = (value: MoneyAmount | null | undefined): string | null =>
      value === null || value === undefined ? null : Money.format(value);
    await this.audit.record({
      action: 'bot_connection.terms_changed',
      entityType: 'bot_connection',
      entityId: before.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: {
        message_price: format(before.messagePrice),
        monthly_fee: format(before.monthlyFee),
      },
      after: { message_price: format(after?.messagePrice), monthly_fee: format(after?.monthlyFee) },
    });
    return this.adminClients();
  }

  // --- Отправка -----------------------------------------------------------------------------------

  /**
   * Можно ли отправить сообщение на этот номер ботом клиента: продукт включён, бот работает, клиент к нему
   * подключён, а у номера есть живой подписчик этого клиента. Возвращает бота и цену сообщения; `undefined` —
   * сообщение пойдёт через аккаунты.
   */
  async routeFor(
    clientId: Id<'client'>,
    recipient: string,
    now: Date = new Date(),
  ): Promise<{ botId: BotId; price: MoneyAmount } | undefined> {
    const [settings, bot, connection] = await Promise.all([
      this.settings.bot(),
      this.repository.findPlatformBot(),
      this.repository.findConnectionByClient(clientId),
    ]);
    if (!settings.enabled || bot?.status !== 'active') return undefined;
    if (connection?.enabled !== true || connection.botId !== bot.id) return undefined;
    const terms = await this.termsOf(connection);
    // Плата за месяц не взята — бот клиенту не отправляет, сообщения идут через аккаунты.
    if (!this.feePaid(connection, terms, now)) return undefined;
    if ((await this.repository.findReachable(clientId, recipient)) === undefined) return undefined;
    return { botId: bot.id, price: terms.messagePrice };
  }

  /**
   * Отправляет текст подписчику клиента. `BotRecipientRejectedError` — подписчика нет или он остановил бота:
   * окончательно; прочее — временный сбой, сообщение повторится.
   */
  async sendTo(
    botId: BotId,
    clientId: Id<'client'>,
    recipient: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const bot = await this.repository.findBot(botId);
    if (bot?.status !== 'active') throw dependencyUnavailable('Бот сейчас недоступен');
    const subscriber = await this.repository.findReachable(clientId, recipient);
    if (subscriber === undefined) throw new BotRecipientRejectedError('нет подписчика');
    try {
      return await this.provider.send(this.tokenOf(bot), subscriber.chatId, text);
    } catch (cause) {
      if (cause instanceof BotRecipientRejectedError) {
        await this.repository.stopSubscriber(subscriber.id);
      }
      throw cause;
    }
  }

  // --- События от MAX ----------------------------------------------------------------------------

  /**
   * Обрабатывает событие бота. Никогда не бросает наружу: платформа повторяет доставку при любой ошибке, а
   * разбираться с неудавшимся ответом человеку незачем — достаточно записи в журнал.
   */
  async handleUpdate(botId: BotId, update: BotUpdate): Promise<void> {
    try {
      const bot = await this.repository.findBot(botId);
      if (bot?.status !== 'active') return;
      if (update.update_type === 'bot_started') {
        await this.onStarted(bot, update);
      } else if (update.update_type === 'message_created') {
        await this.onMessage(bot, update);
      }
    } catch (cause) {
      this.logger.error('Событие бота не обработано', cause, { bot_id: botId });
    }
  }

  private async onStarted(bot: BotRow, update: BotUpdate): Promise<void> {
    const userId = idOf(update.user?.user_id);
    const chatId = idOf(update.chat_id);
    if (userId === undefined || chatId === undefined) return;
    const token = this.tokenOf(bot);

    const connection =
      update.payload === undefined || update.payload === ''
        ? undefined
        : await this.repository.findConnectionByCode(update.payload);
    if (connection?.enabled !== true || connection.botId !== bot.id) {
      await this.provider.send(token, chatId, TEXT.needLink);
      return;
    }
    await this.repository.startSubscriber({
      botId: bot.id,
      clientId: connection.clientId,
      maxUserId: userId,
      chatId,
    });
    const client = await this.billing.clientWithBalance(connection.clientId);
    await this.provider.send(token, chatId, TEXT.askContact(client.name), {
      requestContact: TEXT.shareButton,
    });
  }

  private async onMessage(bot: BotRow, update: BotUpdate): Promise<void> {
    const message = update.message;
    const userId = idOf(message?.sender?.user_id);
    const chatId = idOf(message?.recipient?.chat_id);
    if (userId === undefined || chatId === undefined) return;
    const token = this.tokenOf(bot);

    const contact = [...(message?.body?.attachments ?? []), ...(message?.attachments ?? [])].find(
      (attachment) => attachment.type === 'contact',
    );
    if (contact !== undefined) {
      // Принимается только контакт, который человек прислал о себе: чужой номер привязки не создаёт.
      const owner = idOf(contact.payload?.max_info?.user_id);
      const phone = phoneOf(contact.payload?.vcf_info);
      if (owner !== userId || phone === undefined) {
        await this.provider.send(token, chatId, TEXT.notYours);
        return;
      }
      const linked = await this.repository.setPhone(bot.id, userId, phone);
      await this.provider.send(token, chatId, linked > 0 ? TEXT.thanks : TEXT.needLink);
      return;
    }

    const text = message?.body?.text?.trim().toLowerCase();
    if (text === 'стоп' || text === '/stop' || text === 'stop') {
      await this.repository.stopUser(bot.id, userId);
      await this.provider.send(token, chatId, TEXT.stopped);
      return;
    }
    await this.provider.send(token, chatId, TEXT.help);
  }
}

/** Идентификаторы MAX приходят то числом, то строкой: храним строкой. */
function idOf(value: number | string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : String(value);
}

/** Номер из визитки контакта: `TEL;TYPE=cell:+79001234567`. */
function phoneOf(vcf: string | undefined): string | undefined {
  const line = /TEL[^:\r\n]*:([+\d\s()-]+)/iu.exec(vcf ?? '');
  return line?.[1] === undefined ? undefined : normalizeMsisdn(line[1].trim());
}
