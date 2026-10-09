/**
 * Выбор аккаунта под сообщение ([ADR-0079](../../../../../docs/adr/0079-raspredelenie-soobscheniy-i-zdorove-akkauntov.md),
 * [ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)): из самой дешёвой цены берутся аккаунты
 * допущенных партнёров, у каждого партнёра лучший выбирается по его режиму распределения, между партнёрами — с
 * короткой очередью. Изнутри ходит только в хранилища сообщений и аккаунтов и в биллинг за статусом партнёра.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DistributionProduct, Id, MoneyAmount } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { BillingService } from '../billing/billing.service.js';
import { DistributionService } from '../limits/distribution.service.js';
import { DEFAULT_DISTRIBUTION, quietEndsAt, type DistributionSettings } from '@zvonix/shared';
import { chooseByMode, isFree, type Candidate } from './distribution.js';
import { MessagesRepository, type AccountLoad } from './messages.repository.js';
import { MessagingRepository, type MessengerAccountRow } from './messaging.repository.js';

/** Сколько аккаунтов смотрится за один заход: хватает, чтобы найти свободный, и не читает все. */
const CANDIDATES = 12;
/** Сколько заходов (страниц и повторов после исключения недопущенных партнёров) делается на выбор. */
const MAX_ROUNDS = 6;
/** Как давно писали номеру, чтобы «один получатель — один аккаунт» ещё считался: месяц. */
const STICKY_DAYS = 30;
const EMPTY_LOAD: AccountLoad = { minute: 0, hour: 0, day: 0, backlog: 0 };
const PRODUCT: DistributionProduct = 'message';

/** Перевыбор при отправке: тот же партнёр, та же цена, без самого аккаунта. */
export interface PickScope {
  readonly partnerId: Id<'partner'>;
  readonly price: MoneyAmount;
  readonly exceptId: Id<'messengerAccount'>;
  readonly paceSeconds: number;
}

@Injectable()
export class AccountPicker {
  private readonly logger: Logger;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly accounts: MessagingRepository,
    private readonly billing: BillingService,
    private readonly distribution: DistributionService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('account-picker');
  }

  /** Настройка партнёра для сообщений; нет записи — «поровну» без параметров. */
  async settingsOf(partnerId: Id<'partner'>): Promise<DistributionSettings> {
    return this.distribution.get(partnerId, PRODUCT);
  }

  /** Когда у аккаунта кончатся тихие часы партнёра; `undefined` — сейчас не тихие часы. */
  async quietEnd(account: MessengerAccountRow, now: Date): Promise<Date | undefined> {
    return quietEndsAt(await this.settingsOf(account.partnerId), now);
  }

  /**
   * Аккаунт под сообщение. Без `scope` — приём: свободного нет — первый по давности из самой дешёвой цены (сообщение
   * подождёт, цена клиенту не прыгает). С `scope` — перевыбор при отправке: только свободный, иначе `undefined`.
   * `sticky` — клиент и получатель: если партнёр включил «один получатель — один аккаунт» и прежний аккаунт свободен,
   * берётся он.
   */
  async pick(
    now: Date,
    options: {
      scope?: PickScope;
      sticky?: { clientId: Id<'client'>; recipient: string };
      paceSeconds?: number;
    } = {},
  ): Promise<MessengerAccountRow | undefined> {
    const { scope, sticky } = options;
    const paceSeconds = scope?.paceSeconds ?? options.paceSeconds ?? 0;
    const verified = new Set<string>();
    const excluded: Id<'partner'>[] = [];
    let offset = 0;
    let fallback: MessengerAccountRow | undefined;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const candidates = await this.messages.listCandidates({
        now,
        limit: CANDIDATES,
        offset,
        exceptPartners: excluded,
        ...(scope === undefined
          ? {}
          : { partnerId: scope.partnerId, price: scope.price, exceptId: scope.exceptId }),
      });
      if (candidates.length === 0) break;

      // Недопущенный партнёр исключается из запроса, а страница читается заново: его аккаунты не листаются.
      const usable: MessengerAccountRow[] = [];
      let dropped = false;
      for (const account of candidates) {
        if (!verified.has(account.partnerId)) {
          const status = (await this.billing.partnerWithBalance(account.partnerId)).status;
          if (status !== 'verified') {
            if (!excluded.includes(account.partnerId)) excluded.push(account.partnerId);
            dropped = true;
            continue;
          }
          verified.add(account.partnerId);
        }
        usable.push(account);
      }
      // Исключили недопущенных партнёров: страница сдвинулась, читаем заново с той же позиции.
      if (dropped) continue;
      offset += CANDIDATES;
      if (usable.length === 0) continue;
      fallback ??= usable[0];

      const loads = await this.messages.loadOf(
        usable.map((account) => account.id),
        now,
      );
      const settings = await this.distribution.forPartners(
        [...new Set(usable.map((account) => account.partnerId))],
        PRODUCT,
      );

      if (sticky !== undefined && round === 0) {
        const remembered = await this.stickyAccount(sticky, usable, settings, now, paceSeconds);
        if (remembered !== undefined) return remembered;
      }

      // Лучший у каждого партнёра по его режиму; между партнёрами — с короткой очередью, при равенстве — ранний.
      const byPartner = new Map<string, Candidate[]>();
      for (const account of usable) {
        const list = byPartner.get(account.partnerId) ?? [];
        list.push({ account, load: loads.get(account.id) ?? EMPTY_LOAD });
        byPartner.set(account.partnerId, list);
      }
      let best: Candidate | undefined;
      for (const [partnerId, list] of byPartner) {
        const chosen = chooseByMode(
          list,
          settings.get(partnerId) ?? DEFAULT_DISTRIBUTION,
          now,
          paceSeconds,
        );
        if (
          chosen !== undefined &&
          (best === undefined || chosen.load.backlog < best.load.backlog)
        ) {
          best = chosen;
        }
      }
      if (best !== undefined) return best.account;
      // Свободных на этой странице нет — следующая страница (режимы «по порядку» и «по приоритету» идут по списку).
    }
    return scope === undefined ? fallback : undefined;
  }

  /** Прежний аккаунт этого клиента для этого номера, если он из выбранной цены, свободен и партнёр это включил. */
  private async stickyAccount(
    sticky: { clientId: Id<'client'>; recipient: string },
    usable: readonly MessengerAccountRow[],
    settings: Map<string, DistributionSettings>,
    now: Date,
    paceSeconds: number,
  ): Promise<MessengerAccountRow | undefined> {
    const since = new Date(now.getTime() - STICKY_DAYS * 86_400_000);
    const previousId = await this.messages.lastAccountFor(sticky.clientId, sticky.recipient, since);
    if (previousId === undefined) return undefined;
    const previous = await this.accounts.findById(previousId);
    const tier = usable[0]?.price;
    if (
      previous === undefined ||
      previous.status !== 'active' ||
      tier === undefined ||
      tier === null ||
      previous.price !== tier
    ) {
      return undefined;
    }
    const own = settings.get(previous.partnerId) ?? (await this.settingsOf(previous.partnerId));
    if (!own.stickyRecipient) return undefined;
    if ((await this.billing.partnerWithBalance(previous.partnerId)).status !== 'verified') {
      return undefined;
    }
    const load = (await this.messages.loadOf([previous.id], now)).get(previous.id) ?? EMPTY_LOAD;
    if (!isFree({ account: previous, load }, own, now, paceSeconds)) return undefined;
    this.logger.debug('Получателю подобран прежний аккаунт', { account_id: previous.id });
    return previous;
  }
}
