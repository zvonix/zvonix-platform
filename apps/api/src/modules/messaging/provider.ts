/**
 * Доступ к мессенджеру MAX — граница с провайдером
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Код площадки знает только этот интерфейс: провайдера можно заменить, а партнёры и клиенты этого
 * не заметят. Ни одно имя, адрес и ключ провайдера за пределы площадки не уходит; ошибки провайдера
 * превращаются в наши (`dependencyUnavailable` с нашим текстом), подробность идёт в журнал.
 */

import type { MessengerProviderId } from '@zvonix/shared';

/** Как найти инстанс у провайдера. Ключ — в открытом виде: расшифровывается только на вызове. */
export interface ProviderAccountRef {
  readonly instanceId: string;
  readonly token: string;
  readonly apiUrl: string;
}

/** Состояние аккаунта в терминах площадки. */
export type ProviderState =
  'authorized' | 'not_authorized' | 'blocked' | 'suspended' | 'starting' | 'unknown';

export type QrResult =
  | { readonly kind: 'qr'; readonly image: string }
  | { readonly kind: 'authorized' }
  /** QR отсканирован, но в аккаунте MAX включён облачный пароль (двухфакторный вход): нужен его ввод. */
  | { readonly kind: 'password_required' }
  | { readonly kind: 'unavailable' };

/** Почему MAX не принял облачный пароль. */
export type PasswordRejection =
  'invalid_password' | 'rate_limit' | 'not_started' | 'timeout' | 'other';

/** У номера нет аккаунта MAX (или получатель недоступен навсегда): повторять бессмысленно, деньги возвращаются. */
export class RecipientRejectedError extends Error {
  override readonly name = 'RecipientRejectedError';
}

/** Итог проверки номера до отправки. */
/** `limited` — у аккаунта исчерпан предел проверок: некоторое время его не спрашивают. */
export type RecipientCheck = 'exists' | 'absent' | 'unknown' | 'limited';

/**
 * Результат проверки партнёрского ключа: `ok` — ключ принят (`instances` — сколько аккаунтов уже заведено),
 * `no_key` — ключ не задан, `rejected` — провайдер ключ не принял, `unreachable` — нет связи с провайдером.
 */
export type AccessCheck =
  | { readonly state: 'ok'; readonly instances: number }
  | { readonly state: 'no_key' | 'rejected' | 'unreachable' };

export interface MessageProvider {
  readonly id: MessengerProviderId;

  /** Проверяет сохранённый партнёрский ключ, ничего не создавая и не тратя денег. */
  checkAccess(): Promise<AccessCheck>;

  /** Заводит инстанс у провайдера (оплачивает площадка). Без партнёрского ключа — отказ. */
  createAccount(): Promise<ProviderAccountRef>;

  /** QR-код для входа аккаунтом MAX. Живёт недолго: клиент запрашивает заново раз в несколько секунд. */
  qr(ref: ProviderAccountRef): Promise<QrResult>;

  /**
   * Передаёт облачный пароль MAX, чтобы завершить вход по QR. Пароль не хранится и не логируется:
   * он уходит провайдеру в этом вызове и больше нигде не остаётся.
   */
  sendPassword(
    ref: ProviderAccountRef,
    password: string,
  ): Promise<
    { readonly accepted: true } | { readonly accepted: false; readonly reason: PasswordRejection }
  >;

  /** Состояние и номер, под которым вошёл аккаунт. */
  state(ref: ProviderAccountRef): Promise<{ state: ProviderState; phone: string | null }>;

  /** Удаляет инстанс у провайдера: платить за него перестаёт площадка. */
  deleteAccount(ref: ProviderAccountRef): Promise<void>;

  /**
   * Отправляет текст получателю (`recipient` — номер из одиннадцати цифр с семёрки). Возвращает
   * идентификатор сообщения у провайдера — по нему придёт статус доставки.
   *
   * `RecipientRejectedError` — получателя нет в MAX, повтор не поможет. Любой другой сбой —
   * временный (`dependencyUnavailable`): сообщение остаётся в очереди и будет отправлено повторно.
   */
  sendText(
    ref: ProviderAccountRef,
    recipient: string,
    text: string,
  ): Promise<{ messageId: string }>;

  /**
   * Есть ли у номера аккаунт MAX, до отправки. `unknown` — выяснить не удалось (провайдер недоступен,
   * лимит проверок, номер не из поддержанных стран): сообщение тогда всё равно отправляется, а отказ
   * получателя ловится по ответу отправки. Ошибок не бросает.
   */
  checkRecipient(ref: ProviderAccountRef, recipient: string): Promise<RecipientCheck>;

  /** Сообщает инстансу адрес, на который слать статусы доставки и смену состояния. */
  configureWebhook(ref: ProviderAccountRef, url: string): Promise<void>;
}

export const MESSAGE_PROVIDER = Symbol('MESSAGE_PROVIDER');
