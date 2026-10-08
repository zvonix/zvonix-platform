/**
 * Доступ к API ботов MAX — граница с платформой
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 *
 * Как и у аккаунтов (ADR-0071), код площадки знает только этот интерфейс. Ошибки платформы превращаются в наши,
 * подробность идёт в журнал.
 */

/** Каким MAX знает бота по токену. */
export interface BotIdentity {
  readonly userId: string;
  readonly name: string;
  readonly username: string;
}

/** MAX не принял токен бота (неверный, отозванный, бот удалён). */
export class BotTokenRejectedError extends Error {
  override readonly name = 'BotTokenRejectedError';
}

/** Получателю писать нельзя (остановил бота, чат закрыт): повтор не поможет. */
export class BotRecipientRejectedError extends Error {
  override readonly name = 'BotRecipientRejectedError';
}

export interface BotProvider {
  /** Проверяет токен и возвращает, чей он бот. `BotTokenRejectedError` — токен негоден; иное — временный сбой. */
  me(token: string): Promise<BotIdentity>;

  /** Подписывает бота на события: человек запустил бота, написал боту. События придут на `url` с `secret`. */
  subscribe(token: string, url: string, secret: string): Promise<void>;

  /** Снимает подписку (бот отключён администратором или клиентом). Не бросает, если подписки уже нет. */
  unsubscribe(token: string, url: string): Promise<void>;

  /**
   * Пишет в чат. `requestContact` — подпись кнопки «Поделиться номером», которую MAX покажет под сообщением.
   * `BotRecipientRejectedError` — писать больше нельзя; прочее — временный сбой.
   */
  send(
    token: string,
    chatId: string,
    text: string,
    options?: { readonly requestContact?: string },
  ): Promise<{ messageId: string }>;
}

export const BOT_PROVIDER = Symbol('BOT_PROVIDER');
