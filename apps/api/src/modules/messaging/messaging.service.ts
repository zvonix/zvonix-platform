/**
 * Аккаунты MAX партнёров: заведение, вход по QR-коду, состояние, цена и лимиты
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Провайдер доступа к мессенджеру скрыт за `MessageProvider`: здесь нет ни его имени, ни его
 * терминов. Партнёру отдаётся только то, что он вправе знать, — без данных инстанса.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  MESSAGE_PRICE_MAX_RUBLES,
  MESSAGE_PRICE_MIN_RUBLES,
  MESSENGER_ACCOUNTS_PER_PARTNER_MAX,
  MESSENGER_LIMIT_MAX,
  Money,
  notFound,
  parseId,
  validationFailed,
  type Id,
  type MessengerAccountStatus,
  type MoneyAmount,
  type UserRole,
} from '@zvonix/shared';
import { createHmac } from 'node:crypto';
import { decryptSecret, encryptSecret, MESSENGER_TOKEN_PURPOSE } from '../../infra/secret-box.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MessagingRepository, type MessengerAccountRow } from './messaging.repository.js';
import {
  MESSAGE_PROVIDER,
  type MessageProvider,
  type ProviderAccountRef,
  type ProviderState,
  type QrResult,
} from './provider.js';

/** Состояние аккаунта сверяется с провайдером не чаще раза в минуту. */
const ACCOUNT_CHECK_INTERVAL_MS = 55_000;

/** Аккаунтов за один проход сверки. */
const ACCOUNT_CHECK_BATCH = 50;

/** Кто действует: учётная запись и роль — для журнала. */
export interface MessagingActor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

/** Что партнёр меняет у аккаунта. `null` у цены и лимита — снять. */
export interface AccountTerms {
  readonly label?: string;
  readonly price?: MoneyAmount | null;
  readonly limitPerMinute?: number | null;
  readonly limitPerDay?: number | null;
}

/** Состояние провайдера → состояние аккаунта. `undefined` — оставить как есть. */
function statusAfter(
  current: MessengerAccountStatus,
  state: ProviderState,
): MessengerAccountStatus | undefined {
  if (state === 'authorized') return 'active';
  if (state === 'blocked') return 'unavailable';
  // Вышел из MAX: ждавшему QR (`pending`) это штатно, работавший становится недоступным.
  if (state === 'not_authorized') return current === 'pending' ? 'pending' : 'unavailable';
  return undefined;
}

@Injectable()
export class MessagingService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: MessagingRepository,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('messaging');
  }

  /** Данные инстанса для вызова провайдера; ключ расшифровывается здесь и дальше не хранится. */
  refOf(row: MessengerAccountRow): ProviderAccountRef {
    return {
      instanceId: row.providerInstanceId,
      token: decryptSecret(row.providerToken, this.config.SECRET_KEY, MESSENGER_TOKEN_PURPOSE),
      apiUrl: row.providerApiUrl,
    };
  }

  /**
   * Секретная часть адреса приёма статусов доставки. Выводится из `SECRET_KEY`: хранить нечего,
   * а подобрать адрес без ключа нельзя; смена `SECRET_KEY` меняет и адрес (инстансы настраиваются заново).
   */
  webhookSecret(): string {
    return createHmac('sha256', this.config.SECRET_KEY)
      .update('zvonix:messenger-webhook:v1')
      .digest('hex')
      .slice(0, 32);
  }

  private webhookUrl(): string {
    return `${this.config.WEB_BASE_URL.replace(/\/+$/u, '')}/api/webhooks/messenger/${this.webhookSecret()}`;
  }

  /** Говорит инстансу, куда слать статусы. Не вышло — не страшно: сверка состояния и повтор есть. */
  private async configureWebhook(row: MessengerAccountRow): Promise<void> {
    try {
      await this.provider.configureWebhook(this.refOf(row), this.webhookUrl());
    } catch (cause) {
      this.logger.warn('Адрес статусов доставки у провайдера не задан', {
        account_id: row.id,
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
    }
  }

  async isEnabled(): Promise<boolean> {
    return (await this.settings.messaging()).enabled;
  }

  /** Уведомление провайдера о смене состояния: сверяем аккаунт сразу, не дожидаясь минуты. */
  async refreshByInstance(instanceId: string): Promise<void> {
    const account = await this.repository.findByInstance(this.provider.id, instanceId);
    if (account === undefined || account.status === 'retired') return;
    await this.refreshOne(account).catch(() => undefined);
  }

  /** Продукт включает владелец (`messaging.enabled`): до этого раздел закрыт. */
  async assertEnabled(): Promise<void> {
    if (!(await this.settings.messaging()).enabled) {
      throw conflict('Сообщения MAX пока не подключены — обратитесь в поддержку');
    }
  }

  /** Аккаунт партнёра-владельца. Чужой — «не найден», а не «нельзя»: существование не выдаётся. */
  private async ownAccount(
    userId: Id<'user'>,
    id: string,
  ): Promise<{ partnerId: Id<'partner'>; account: MessengerAccountRow }> {
    const partner = await this.billing.requirePartnerOwnedBy(userId);
    const account = await this.repository.findById(parseId(id, 'messengerAccount'));
    if (account?.partnerId !== partner.id || account.status === 'retired') {
      throw notFound('Аккаунт не найден');
    }
    return { partnerId: partner.id, account };
  }

  async listOwn(userId: Id<'user'>): Promise<MessengerAccountRow[]> {
    const partner = await this.billing.requirePartnerOwnedBy(userId);
    return this.repository.listOfPartner(partner.id);
  }

  /** Все живые аккаунты площадки с названием партнёра — для сотрудников. */
  async listAll(): Promise<{ account: MessengerAccountRow; partnerName: string }[]> {
    const rows = await this.repository.listLive();
    const names = new Map<string, string>();
    for (const row of rows) {
      if (names.has(row.partnerId)) continue;
      const partner = await this.billing.partnerWithBalance(row.partnerId);
      names.set(row.partnerId, partner.name);
    }
    return rows.map((account) => ({ account, partnerName: names.get(account.partnerId) ?? '' }));
  }

  /** Партнёр заводит себе аккаунт: площадка создаёт инстанс у провайдера, дальше — QR-код. */
  async createOwn(actor: MessagingActor, label: string): Promise<MessengerAccountRow> {
    await this.assertEnabled();
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    if (partner.status !== 'verified') {
      throw conflict('Аккаунты MAX заводит партнёр, допущенный к работе');
    }
    if (
      (await this.repository.countLiveOfPartner(partner.id)) >= MESSENGER_ACCOUNTS_PER_PARTNER_MAX
    ) {
      throw conflict(`Аккаунтов уже ${String(MESSENGER_ACCOUNTS_PER_PARTNER_MAX)} — это предел`);
    }

    const ref = await this.provider.createAccount();
    const row = await this.store(actor, partner.id, label, ref);
    await this.configureWebhook(row);
    return row;
  }

  /**
   * Администратор заводит аккаунт по данным готового инстанса — пока нет партнёрского ключа
   * провайдера или когда инстанс заведён в его кабинете.
   */
  async registerByAdmin(
    actor: MessagingActor,
    input: {
      partnerId: Id<'partner'>;
      label: string;
      instanceId: string;
      token: string;
      apiUrl: string;
    },
  ): Promise<MessengerAccountRow> {
    const partner = await this.billing.partnerWithBalance(input.partnerId);
    const row = await this.store(actor, partner.id, input.label, {
      instanceId: input.instanceId,
      token: input.token,
      apiUrl: input.apiUrl.replace(/\/+$/u, ''),
    });
    await this.configureWebhook(row);
    // Сверка сразу: данные могли оказаться негодными, и узнать об этом лучше на заведении.
    return this.refreshOne(row).catch(() => row);
  }

  private async store(
    actor: MessagingActor,
    partnerId: Id<'partner'>,
    label: string,
    ref: ProviderAccountRef,
  ): Promise<MessengerAccountRow> {
    const row = await this.repository.insert({
      partnerId,
      label,
      provider: this.provider.id,
      providerInstanceId: ref.instanceId,
      providerToken: encryptSecret(ref.token, this.config.SECRET_KEY, MESSENGER_TOKEN_PURPOSE),
      providerApiUrl: ref.apiUrl,
    });
    await this.audit.record({
      action: 'messenger_account.created',
      entityType: 'messenger_account',
      entityId: row.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      // Ни ключа, ни идентификатора инстанса в журнал не попадает.
      after: { partner_id: partnerId, label },
    });
    return row;
  }

  /** QR-код для входа. Вошёл — аккаунт сразу становится рабочим, и сказано об этом. */
  async qrOwn(userId: Id<'user'>, id: string): Promise<QrResult> {
    const { account } = await this.ownAccount(userId, id);
    const result = await this.provider.qr(this.refOf(account));
    if (result.kind === 'authorized') await this.refreshOne(account).catch(() => undefined);
    return result;
  }

  /** Сверяет аккаунт с провайдером и записывает состояние. Сбой провайдера состояние не меняет. */
  async refreshOne(account: MessengerAccountRow, now = new Date()): Promise<MessengerAccountRow> {
    const observed = await this.provider.state(this.refOf(account));
    const next = statusAfter(account.status, observed.state) ?? account.status;
    const updated = await this.repository.setState(account.id, {
      status: next,
      phone: observed.phone ?? account.phone,
      checkedAt: now,
    });
    if (updated === undefined) return account;
    if (updated.status !== account.status) {
      this.logger.info('Состояние аккаунта MAX изменилось', {
        account_id: account.id,
        from: account.status,
        to: updated.status,
      });
      await this.audit.record({
        action: 'messenger_account.status_changed',
        entityType: 'messenger_account',
        entityId: account.id,
        before: { status: account.status },
        after: { status: updated.status },
      });
    }
    return updated;
  }

  /** Фоновая сверка (ADR-0020): аккаунты, не сверявшиеся дольше срока. Сбой одного не гасит остальных. */
  async refreshDue(now = new Date()): Promise<number> {
    const due = await this.repository.listDueForCheck(
      new Date(now.getTime() - ACCOUNT_CHECK_INTERVAL_MS),
      ACCOUNT_CHECK_BATCH,
    );
    let checked = 0;
    for (const account of due) {
      try {
        await this.refreshOne(account, now);
        checked += 1;
      } catch (cause) {
        this.logger.warn('Сверка аккаунта MAX не удалась', {
          account_id: account.id,
          reason: cause instanceof Error ? cause.name : 'unknown',
        });
      }
    }
    return checked;
  }

  /** Партнёр задаёт название, цену за сообщение и лимиты своего аккаунта. */
  async updateOwn(
    actor: MessagingActor,
    id: string,
    terms: AccountTerms,
  ): Promise<MessengerAccountRow> {
    const { account } = await this.ownAccount(actor.userId, id);
    this.assertTerms(terms);

    const updated = await this.repository.setTerms(account.id, terms);
    if (updated === undefined) throw notFound('Аккаунт не найден');
    await this.audit.record({
      action: 'messenger_account.terms_changed',
      entityType: 'messenger_account',
      entityId: account.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: termsView(account),
      after: termsView(updated),
    });
    return updated;
  }

  private assertTerms(terms: AccountTerms): void {
    if (terms.price !== undefined && terms.price !== null) {
      const min = Money.fromMajorUnits(MESSAGE_PRICE_MIN_RUBLES);
      const max = Money.fromMajorUnits(MESSAGE_PRICE_MAX_RUBLES);
      if (Money.compare(terms.price, min) < 0 || Money.compare(terms.price, max) > 0) {
        throw validationFailed(
          `Цена за сообщение — от ${MESSAGE_PRICE_MIN_RUBLES} до ${MESSAGE_PRICE_MAX_RUBLES} ₽`,
        );
      }
    }
    for (const limit of [terms.limitPerMinute, terms.limitPerDay]) {
      if (limit !== undefined && limit !== null && (limit < 1 || limit > MESSENGER_LIMIT_MAX)) {
        throw validationFailed(`Лимит — от 1 до ${String(MESSENGER_LIMIT_MAX)}`);
      }
    }
    if (
      terms.limitPerMinute !== undefined &&
      terms.limitPerMinute !== null &&
      terms.limitPerDay !== undefined &&
      terms.limitPerDay !== null &&
      terms.limitPerMinute > terms.limitPerDay
    ) {
      throw validationFailed('Лимит в минуту не может быть больше лимита в сутки');
    }
  }

  /** Партнёр списывает аккаунт: инстанс у провайдера удаляется, платить за него перестаёт площадка. */
  async retireOwn(actor: MessagingActor, id: string): Promise<void> {
    const { account } = await this.ownAccount(actor.userId, id);
    await this.retire(actor, account);
  }

  async retireByAdmin(actor: MessagingActor, id: string): Promise<void> {
    const account = await this.repository.findById(parseId(id, 'messengerAccount'));
    if (account === undefined || account.status === 'retired') throw notFound('Аккаунт не найден');
    await this.retire(actor, account);
  }

  private async retire(actor: MessagingActor, account: MessengerAccountRow): Promise<void> {
    const retired = await this.repository.retire(account.id);
    if (retired === undefined) return;

    // Сначала списание в базе, потом удаление у провайдера: сбой провайдера не должен оставить
    // партнёра с аккаунтом, который он уже списал. Не удалилось — предупреждение, платить за инстанс
    // будет площадка до ручного удаления.
    try {
      await this.provider.deleteAccount(this.refOf(account));
    } catch (cause) {
      this.logger.warn('Инстанс аккаунта MAX у провайдера не удалён — удалить вручную', {
        account_id: account.id,
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
    }
    await this.audit.record({
      action: 'messenger_account.retired',
      entityType: 'messenger_account',
      entityId: account.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { status: account.status },
      after: { status: 'retired' },
    });
  }
}

/** Что из условий аккаунта идёт в журнал. */
function termsView(row: MessengerAccountRow) {
  return {
    label: row.label,
    price: row.price === null ? null : Money.format(row.price),
    limit_per_minute: row.limitPerMinute,
    limit_per_day: row.limitPerDay,
  };
}
