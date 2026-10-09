/**
 * Сообщения MAX: приём, очередь, отправка, возврат, статусы доставки
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Поток: клиент присылает сообщение → выбирается самый дешёвый рабочий аккаунт, цена и наценка
 * фиксируются, деньги списываются, строка встаёт в очередь (одной транзакцией: нет денег — нет
 * сообщения) → воркер отправляет с паузой и в пределах лимитов аккаунта → статусы доставки приходят
 * от провайдера. Не ушло окончательно — возврат обратной проводкой.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  dependencyUnavailable,
  MESSAGE_MAX_ATTEMPTS,
  MESSAGE_MAX_LENGTH,
  Money,
  normalizeMsisdn,
  validationFailed,
  type CommissionRule,
  type Id,
  type MessageChannel,
  type MessageFailureReason,
  type MoneyAmount,
} from '@zvonix/shared';
import { RedisService } from '../../infra/redis.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { MessengerAccountRow } from './messaging.repository.js';
import { BotsService } from './bot/bots.service.js';
import { BotRecipientRejectedError } from './bot/bot.provider.js';
import { MessagingService } from './messaging.service.js';
import { AccountPicker } from './account-picker.js';
import { accountReadyAt } from './warmup.js';
import {
  MessagesRepository,
  type AccountLoad,
  type MessageFilter,
  type MessageRow,
} from './messages.repository.js';
import {
  MESSAGE_PROVIDER,
  RecipientRejectedError,
  type MessageProvider,
  type RecipientCheck,
} from './provider.js';

/** Сколько сообщений воркер берёт за проход: с запасом на паузы, но без многоминутного прохода. */
const DISPATCH_BATCH = 50;

const EMPTY_LOAD: AccountLoad = { minute: 0, hour: 0, day: 0, backlog: 0 };
const HEALTH_WINDOW_MS = 86_400_000;

/** Повтор после временного сбоя: 1, 2, 4, 8 минут — и возврат. */
const BACKOFF_BASE_SECONDS = 60;

/** Пауза проверок аккаунта после отказа «лимит исчерпан»: столько советует провайдер. */
const CHECK_PAUSE_SECONDS = 2 * 3600;

/** Сколько суток помнится результат проверки номера (настройки площадки); `null` вместо него — проверки нет. */
interface PrecheckMemory {
  readonly existsDays: number;
  readonly absentDays: number;
}

/** Сообщений на проход проверки «ждёт слишком долго». */
const EXPIRY_BATCH = 100;

/** Цена и сумма клиента за одно сообщение сейчас. */
export interface Quote {
  readonly partnerAmount: MoneyAmount;
  readonly commissionAmount: MoneyAmount;
  readonly clientAmount: MoneyAmount;
}

/**
 * Наценка на сообщение: фикс плюс доля от цены партнёра, вместе (ADR-0073). Долю округляем **вверх** до
 * микроединицы (ADR-0010: округляем один раз и в пользу площадки). Правил нет — наценка нулевая.
 */
function commissionOf(partnerAmount: MoneyAmount, rule: CommissionRule | undefined): MoneyAmount {
  if (rule === undefined) return Money.ZERO;
  const raw = Money.toMicros(partnerAmount) * rule.percentBasisPoints;
  const share = Money.fromMicros((raw + 9_999n) / 10_000n);
  return Money.add(rule.fixedFee, share);
}

@Injectable()
export class MessagesService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: MessagesRepository,
    private readonly messaging: MessagingService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly tariffs: TariffService,
    private readonly redis: RedisService,
    private readonly bots: BotsService,
    private readonly picker: AccountPicker,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('messages');
  }

  private async quoteFor(account: MessengerAccountRow, clientId: Id<'client'>): Promise<Quote> {
    const rule = await this.tariffs.messageCommission(clientId, new Date());
    const partnerAmount = account.price ?? Money.ZERO;
    const commissionAmount = commissionOf(partnerAmount, rule);
    return {
      partnerAmount,
      commissionAmount,
      clientAmount: Money.add(partnerAmount, commissionAmount),
    };
  }

  /**
   * Сколько стоит одно сообщение этому клиенту сейчас; `undefined` — принять некуда. Нет ни одного аккаунта, но у
   * клиента работает бот — называется цена бота: подписчикам клиент отправлять может (ADR-0077).
   */
  async quote(clientId: Id<'client'>): Promise<Quote | undefined> {
    const account = await this.picker.pick(new Date());
    if (account !== undefined) return this.quoteFor(account, clientId);
    const price = await this.bots.connectedPrice(clientId);
    return price === undefined
      ? undefined
      : { partnerAmount: Money.ZERO, commissionAmount: price, clientAmount: price };
  }

  /**
   * Приём сообщения. Повтор с тем же `externalId` возвращает прежнее (деньги не списываются дважды);
   * тот же ключ с другим текстом или получателем — отказ: ключ опознаёт одно сообщение.
   */
  async send(
    clientId: Id<'client'>,
    input: { to: string; text: string; externalId?: string | undefined },
    channel: MessageChannel = 'api',
  ): Promise<MessageRow> {
    await this.messaging.assertEnabled();

    const recipient = normalizeMsisdn(input.to);
    if (recipient === undefined) {
      throw validationFailed('Номер получателя — российский, например 79001234567');
    }
    if (input.text.trim() === '') throw validationFailed('Текст сообщения не может быть пустым');
    if (input.text.length > MESSAGE_MAX_LENGTH) {
      throw validationFailed(`Текст сообщения — не больше ${String(MESSAGE_MAX_LENGTH)} знаков`);
    }

    const client = await this.billing.clientWithBalance(clientId);
    if (client.status !== 'active')
      throw conflict('Отправка сообщений доступна работающему клиенту');

    const externalId = input.externalId ?? null;
    if (externalId !== null) {
      const earlier = await this.repository.findByExternal(clientId, externalId);
      if (earlier !== undefined) return this.sameOrRefuse(earlier, recipient, input.text);
    }

    // Сначала бот: у номера есть подписчик этого клиента (ADR-0077). Иначе — аккаунты партнёров.
    const viaBot = await this.bots.routeFor(clientId, recipient);
    if (viaBot === undefined && (await this.bots.fallbackForbidden(clientId))) {
      throw validationFailed('Получатель не подписан на бота этого клиента');
    }
    const account =
      viaBot === undefined
        ? await this.picker.pick(new Date(), { sticky: { clientId, recipient } })
        : undefined;
    if (viaBot === undefined && account === undefined) {
      throw dependencyUnavailable('Сейчас нет доступных аккаунтов для отправки — повторите позже');
    }

    const id = this.repository.newId();
    try {
      if (viaBot !== undefined) {
        const draft = {
          id,
          clientId,
          externalId,
          channel,
          recipient,
          text: input.text,
          route: 'bot' as const,
          botId: viaBot.botId,
          clientAmount: viaBot.price,
          partnerAmount: Money.ZERO,
          commissionAmount: viaBot.price,
        };
        if (Money.isZero(viaBot.price)) {
          // Бесплатно: денег не двигаем, строка встаёт в очередь сама.
          await this.repository.insert(draft);
        } else {
          await this.billing.chargeBotMessage({
            messageId: id,
            clientId,
            amount: viaBot.price,
            alsoInTransaction: async (tx) => {
              await this.repository.insert(draft, tx);
            },
          });
        }
      } else if (account !== undefined) {
        const quote = await this.quoteFor(account, clientId);
        await this.billing.chargeMessage({
          messageId: id,
          clientId,
          partnerId: account.partnerId,
          clientAmount: quote.clientAmount,
          partnerAmount: quote.partnerAmount,
          commissionAmount: quote.commissionAmount,
          // Строка очереди — той же транзакцией, что и деньги: нет средств — нет и сообщения.
          alsoInTransaction: async (tx) => {
            await this.repository.insert(
              {
                id,
                clientId,
                externalId,
                channel,
                recipient,
                text: input.text,
                accountId: account.id,
                partnerId: account.partnerId,
                clientAmount: quote.clientAmount,
                partnerAmount: quote.partnerAmount,
                commissionAmount: quote.commissionAmount,
              },
              tx,
            );
          },
        });
      }
    } catch (cause) {
      // Две одновременные отправки с одним ключом: вторая упёрлась в уникальный индекс и откатилась
      // вместе со списанием. Отдаём то, что успела первая.
      if (externalId !== null) {
        const winner = await this.repository.findByExternal(clientId, externalId);
        if (winner !== undefined) return this.sameOrRefuse(winner, recipient, input.text);
      }
      throw cause;
    }

    const stored = await this.repository.findById(id);
    if (stored === undefined) throw new Error('Принятое сообщение не найдено');
    return stored;
  }

  private sameOrRefuse(earlier: MessageRow, recipient: string, text: string): MessageRow {
    if (earlier.recipient !== recipient || (earlier.text !== '' && earlier.text !== text)) {
      throw conflict('Этот ключ уже использован для другого сообщения');
    }
    return earlier;
  }

  /** Сколько сообщений принято с `since` и сколько из них окончательно не отправлено — для тревоги. */
  health(since: Date): Promise<{ total: number; failed: number }> {
    return this.repository.healthSince(since);
  }

  /** Обзор для сотрудников: каждые из последних `days` суток (с нулями), плюс итог. */
  async overview(days: number, offsetMinutes: number) {
    const dayOf = (back: number): string =>
      new Date(Date.now() + offsetMinutes * 60_000 - back * 86_400_000).toISOString().slice(0, 10);
    const labels = Array.from({ length: days }, (_unused, index) => dayOf(days - 1 - index));
    const first = labels[0] ?? dayOf(0);
    const since = new Date(Date.parse(`${first}T00:00:00Z`) - offsetMinutes * 60_000);
    const rows = new Map(
      (await this.repository.dailyCounts(since, offsetMinutes)).map((row) => [row.day, row]),
    );
    const series = labels.map((day) => ({
      day,
      messages: rows.get(day)?.messages ?? 0,
      delivered: rows.get(day)?.delivered ?? 0,
      failed: rows.get(day)?.failed ?? 0,
      revenue: Money.fromMicros(rows.get(day)?.revenue ?? 0n),
      margin: Money.fromMicros(rows.get(day)?.margin ?? 0n),
    }));
    return series;
  }

  list(filter: MessageFilter): Promise<{ rows: MessageRow[]; total: number }> {
    return this.repository.list(filter);
  }

  async get(clientId: Id<'client'>, id: string): Promise<MessageRow | undefined> {
    const row = await this.repository.findById(id as Id<'message'>);
    return row?.clientId === clientId ? row : undefined;
  }

  // --- Отправка воркером -----------------------------------------------------------------------

  /**
   * Проход воркера (ADR-0020, догоняющий): берёт то, чему пора уходить, и отправляет по одному с
   * паузой аккаунта и в пределах его лимитов. Сбой одного сообщения остальных не останавливает.
   */
  async dispatchDue(now: Date = new Date()): Promise<number> {
    const settings = await this.settings.messaging();
    const precheck: PrecheckMemory | null = settings.precheckEnabled
      ? { existsDays: settings.precheckExistsDays, absentDays: settings.precheckAbsentDays }
      : null;
    const claimed = await this.repository.claimDue(now, DISPATCH_BATCH);
    let sent = 0;
    for (const message of claimed) {
      try {
        if (await this.dispatchOne(message, now, settings.paceSeconds, precheck)) sent += 1;
      } catch (cause) {
        // Непредвиденное: сообщение возвращается в очередь, чтобы не зависнуть «в работе».
        this.logger.error('Отправка сообщения не удалась', cause, { message_id: message.id });
        await this.repository.requeue(message.id, new Date(now.getTime() + 60_000), false);
      }
    }
    return sent;
  }

  /**
   * Есть ли у номера MAX. Результат помнится в Redis столько суток, сколько задано настройками
   * (у «нет» срок короче: номер мог завести аккаунт), «неизвестно» не помнится. Частые проверки одного номера мессенджер считает подозрительными,
   * поэтому повтор идёт из памяти. Недоступный Redis — просто проверка без памяти.
   */
  private async hasMax(
    account: MessengerAccountRow,
    recipient: string,
    memory: PrecheckMemory,
  ): Promise<RecipientCheck> {
    const key = `messaging:max:${recipient}`;
    try {
      const cached = await this.redis.connection.get(key);
      if (cached === 'exists' || cached === 'absent') return cached;
    } catch (cause) {
      this.logger.warn('Память проверок номеров недоступна', {
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
    }
    const paused = `messaging:max:pause:${account.id}`;
    if ((await this.redis.connection.exists(paused).catch(() => 0)) === 1) return 'unknown';
    const result = await this.provider.checkRecipient(this.messaging.refOf(account), recipient);
    if (result === 'limited') {
      // Предел проверок у мессенджера: пока он не снят, аккаунт только отправляет, а не спрашивает.
      await this.redis.connection
        .set(paused, '1', 'EX', CHECK_PAUSE_SECONDS)
        .catch(() => undefined);
      this.logger.warn('Предел проверок номеров исчерпан, проверки аккаунта приостановлены', {
        account_id: account.id,
      });
      return 'unknown';
    }
    if (result !== 'unknown') {
      const days = result === 'exists' ? memory.existsDays : memory.absentDays;
      const ttl = days * 86_400;
      await this.redis.connection.set(key, result, 'EX', ttl).catch(() => undefined);
    }
    return result;
  }

  /** Сообщение бота: подписчику клиента, без пауз и лимитов аккаунтов (ADR-0077). Доставлено — как только MAX приняло. */
  private async dispatchBot(message: MessageRow, now: Date): Promise<boolean> {
    if (message.botId === null) {
      await this.fail(message, 'platform', now);
      return false;
    }
    try {
      const { messageId } = await this.bots.sendTo(
        message.botId,
        message.clientId,
        message.recipient,
        message.text,
      );
      await this.repository.markSent(message.id, messageId, now);
      await this.repository.markDelivered(message.id, now);
      return true;
    } catch (cause) {
      await this.afterSendFailure(message, cause, now);
      return false;
    }
  }

  /** Отказ получателя — окончательный (возврат); прочее — повтор с паузами, после пяти попыток возврат. */
  private async afterSendFailure(message: MessageRow, cause: unknown, now: Date): Promise<void> {
    if (cause instanceof RecipientRejectedError || cause instanceof BotRecipientRejectedError) {
      await this.fail(message, 'recipient_not_in_max', now);
      return;
    }
    this.logger.warn('Временный сбой отправки сообщения', {
      message_id: message.id,
      attempt: message.attempts,
      reason: cause instanceof Error ? cause.name : 'unknown',
    });
    if (message.attempts >= MESSAGE_MAX_ATTEMPTS) {
      await this.fail(message, 'platform', now);
    } else {
      const delay = BACKOFF_BASE_SECONDS * 2 ** (message.attempts - 1);
      await this.repository.requeue(message.id, new Date(now.getTime() + delay * 1000), false);
    }
  }

  private async dispatchOne(
    message: MessageRow,
    now: Date,
    paceSeconds: number,
    precheck: PrecheckMemory | null,
  ): Promise<boolean> {
    if (message.route === 'bot') return this.dispatchBot(message, now);
    let account =
      message.accountId === null ? undefined : await this.repository.findAccount(message.accountId);
    if (account === undefined || account.status === 'retired') {
      await this.fail(message, 'account_unavailable', now);
      return false;
    }

    // Когда аккаунт сможет отправить: не вошёл или нет связи — ждёт возвращения (пока не истечёт срок ожидания); иначе
    // пауза здоровья, пауза между сообщениями, лимиты в минуту, час и сутки: сверх них сообщение ждёт, а не отклоняется.
    const quietUntil =
      account.status === 'active' ? await this.picker.quietEnd(account, now) : undefined;
    const readyAt =
      account.status !== 'active'
        ? new Date(now.getTime() + 30_000)
        : (quietUntil ??
          accountReadyAt(
            account,
            (await this.repository.loadOf([account.id], now)).get(account.id) ?? EMPTY_LOAD,
            now,
            { paceSeconds, withBacklog: false },
          ));
    if (readyAt !== undefined) {
      // Не может сейчас — сначала сосед того же партнёра и той же цены со свободным запасом (ADR-0079).
      const neighbour =
        message.partnerId === null || account.price === null
          ? undefined
          : await this.picker.pick(now, {
              scope: {
                partnerId: message.partnerId,
                price: account.price,
                exceptId: account.id,
                paceSeconds,
              },
            });
      if (neighbour === undefined) {
        const jitter = Math.floor(Math.random() * 1000);
        await this.repository.requeue(message.id, new Date(readyAt.getTime() + jitter), true);
        return false;
      }
      await this.repository.reassign(message.id, neighbour.id);
      this.logger.info('Сообщение перенесено на другой аккаунт', {
        message_id: message.id,
        from: account.id,
        to: neighbour.id,
      });
      account = neighbour;
    }

    if (
      precheck !== null &&
      (await this.hasMax(account, message.recipient, precheck)) === 'absent'
    ) {
      await this.fail(message, 'recipient_not_in_max', now);
      return false;
    }

    try {
      const { messageId } = await this.provider.sendText(
        this.messaging.refOf(account),
        message.recipient,
        message.text,
      );
      await this.repository.markSent(message.id, messageId, now);
      await this.repository.touchAccount(account.id, now);
      return true;
    } catch (cause) {
      await this.afterSendFailure(message, cause, now);
      return false;
    }
  }

  /** Окончательный отказ с возвратом денег: проводка и состояние — одной транзакцией. */
  async fail(message: MessageRow, reason: MessageFailureReason, now: Date): Promise<void> {
    if (message.partnerId === null) {
      // Сообщение бота: деньги ушли только площадке; бесплатное — возвращать нечего.
      if (Money.isZero(message.clientAmount)) {
        await this.repository.markFailedFree(message.id, reason, now);
      } else {
        await this.billing.refundBotMessage({
          messageId: message.id,
          clientId: message.clientId,
          amount: message.clientAmount,
          alsoInTransaction: (tx) => this.repository.markFailed(message.id, reason, now, tx),
        });
      }
    } else {
      await this.billing.refundMessage({
        messageId: message.id,
        clientId: message.clientId,
        partnerId: message.partnerId,
        clientAmount: message.clientAmount,
        partnerAmount: message.partnerAmount,
        commissionAmount: message.commissionAmount,
        alsoInTransaction: (tx) => this.repository.markFailed(message.id, reason, now, tx),
      });
    }
    this.logger.info('Сообщение не отправлено, деньги возвращены', {
      message_id: message.id,
      reason,
    });
  }

  /**
   * Здоровье аккаунтов ([ADR-0079](../../../../../docs/adr/0079-raspredelenie-soobscheniy-i-zdorove-akkauntov.md)):
   * доля сообщений, у которых MAX после отправки сообщил «нет аккаунта». Слишком высокая — аккаунт на паузу, пока
   * мессенджер не заблокировал его. Последний рабочий аккаунт площадки не трогается. Возвращает, сколько поставлено.
   */
  async checkHealth(now: Date = new Date()): Promise<number> {
    const settings = await this.settings.messaging();
    if (!settings.healthEnabled) return 0;
    const outcomes = await this.repository.healthOutcomes(
      new Date(now.getTime() - HEALTH_WINDOW_MS),
      now,
    );
    const unhealthy = outcomes
      .filter(
        (row) =>
          row.absent + row.ok >= settings.healthMinSample &&
          row.absent * 100 >= settings.healthMaxAbsentPercent * (row.absent + row.ok),
      )
      .sort((a, b) => b.absent / (b.absent + b.ok) - a.absent / (a.absent + a.ok));
    let paused = 0;
    for (const row of unhealthy) {
      if ((await this.repository.countWorking(now)) <= 1) {
        this.logger.warn(
          'Аккаунт с частыми «нет MAX» не поставлен на паузу: он последний рабочий',
          {
            account_id: row.accountId,
            absent: row.absent,
            sent: row.ok,
          },
        );
        break;
      }
      const until = new Date(now.getTime() + settings.healthPauseHours * 3_600_000);
      if (
        await this.messaging.pauseForHealth(row.accountId, now, until, {
          absent: row.absent,
          ok: row.ok,
        })
      ) {
        paused += 1;
      }
    }
    return paused;
  }

  /** Ждавшие дольше допустимого отклоняются с возвратом. Догоняющая проверка по сроку. */
  async expireWaiting(now: Date = new Date()): Promise<number> {
    const { maxWaitMinutes } = await this.settings.messaging();
    const stale = await this.repository.listWaitingBefore(
      new Date(now.getTime() - maxWaitMinutes * 60_000),
      EXPIRY_BATCH,
    );
    for (const message of stale) await this.fail(message, 'wait_expired', now);
    return stale.length;
  }

  // --- Статусы доставки от провайдера ----------------------------------------------------------

  /**
   * Статус доставки: только вперёд (`sent` → `delivered` → `read`). Отказ получателю после отправки
   * возвращает деньги. Незнакомое сообщение или аккаунт молча игнорируются: провайдер шлёт и то,
   * что к нам не относится.
   */
  async applyDeliveryStatus(
    instanceId: string,
    providerMessageId: string,
    status: string,
    now: Date = new Date(),
  ): Promise<void> {
    const account = await this.repository.findAccountByInstance(this.provider.id, instanceId);
    if (account === undefined) return;

    if (status === 'delivered' || status === 'read') {
      await this.repository.advance(account.id, providerMessageId, status, now);
      return;
    }
    if (status === 'failed' || status === 'noAccount') {
      const message = await this.repository.findByProviderId(account.id, providerMessageId);
      if (message?.status === 'sent') {
        await this.fail(message, status === 'noAccount' ? 'recipient_not_in_max' : 'platform', now);
      }
    }
  }

  /** Стирает тексты старше срока хранения (персональные данные). */
  async purgeTexts(now: Date = new Date()): Promise<number> {
    const { textDays } = await this.settings.messaging();
    return this.repository.purgeTexts(new Date(now.getTime() - textDays * 86_400_000));
  }
}
