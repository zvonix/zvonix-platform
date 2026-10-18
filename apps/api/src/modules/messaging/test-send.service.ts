/**
 * Пробное сообщение партнёра через выбранный аккаунт MAX
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md), ревизия 2026-10-18).
 *
 * Для проверки, что вошедший аккаунт действительно отправляет. Мимо очереди, денег и журнала сообщений: деньги не
 * списываются, строки сообщения нет. Защита от превращения в бесплатную рассылку — предел в сутки на аккаунт и
 * запись в журнал действий (адрес получателя маскируется).
 */

import { Inject, Injectable } from '@nestjs/common';
import { normalizeMsisdn, rateLimited, validationFailed } from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import { MessagingService, type MessagingActor } from './messaging.service.js';
import { MESSAGE_PROVIDER, RecipientRejectedError, type MessageProvider } from './provider.js';

/** Сколько пробных сообщений в сутки с одного аккаунта (владелец, 2026-10-18: «хотя бы тестовых семь»). */
export const TEST_MESSAGES_PER_DAY = 7;

const TEST_RULE: LimitRule = {
  name: 'messenger.test_message',
  limit: TEST_MESSAGES_PER_DAY,
  windowSeconds: 86_400,
};

const DEFAULT_TEST_TEXT = 'Проверка связи Zvonix';

/** Адрес для журнала: опознаваемый след, а не номер целиком. */
const maskMsisdn = (msisdn: string): string => `${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`;

@Injectable()
export class TestSendService {
  constructor(
    private readonly messaging: MessagingService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Отправляет пробное сообщение. Возвращает, сколько пробных осталось на сегодня. */
  async send(
    actor: MessagingActor,
    accountId: string,
    input: { recipient: string; text?: string | undefined },
  ): Promise<{ remaining: number }> {
    const { account, ref } = await this.messaging.ownWorkingAccount(actor.userId, accountId);
    const recipient = normalizeMsisdn(input.recipient);
    if (recipient === undefined) {
      throw validationFailed('Номер получателя — одиннадцать цифр, начиная с 7 или 8');
    }

    // Сначала смотрим, потом считаем: сбой отправки не должен съедать из семи пробных.
    const before = await this.limits.check(TEST_RULE, account.id);
    if (!before.allowed) {
      throw rateLimited(
        `Пробных сообщений не больше ${String(TEST_MESSAGES_PER_DAY)} в сутки на аккаунт: попробуйте позже`,
        { details: { retry_after_seconds: before.retryAfterSeconds } },
      );
    }

    try {
      await this.provider.sendText(ref, recipient, input.text ?? DEFAULT_TEST_TEXT);
    } catch (cause) {
      if (cause instanceof RecipientRejectedError) {
        throw validationFailed('У этого номера нет MAX — сообщение не отправлено');
      }
      throw cause;
    }

    const after = await this.limits.hit(TEST_RULE, account.id);
    await this.audit.record({
      action: 'messenger_account.test_sent',
      entityType: 'messenger_account',
      entityId: account.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { recipient: maskMsisdn(recipient) },
    });
    return { remaining: Math.max(0, TEST_MESSAGES_PER_DAY - after.current) };
  }
}
