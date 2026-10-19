/**
 * Обращения в поддержку ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 *
 * Автор видит свои обращения и неслужебные реплики; сотрудники — все и свои заметки. Ответ сотрудника переводит
 * обращение в «ждём вас», ответ автора — в «ждёт сотрудников». Письма уходят в очередь и сбоем почты обращение не ломают.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  notFound,
  parseId,
  rateLimited,
  TICKET_AUTOCLOSE_DAYS,
  TICKET_MESSAGES_PER_DAY,
  TICKETS_OPEN_MAX,
  TICKETS_PER_DAY,
  type Id,
  type TicketCabinet,
  type TicketCategory,
  type TicketStatus,
  type UserRole,
} from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  SupportRepository,
  type TicketFilter,
  type TicketMessageRow,
  type TicketRow,
} from './support.repository.js';

const NEW_TICKET_RULE: LimitRule = {
  name: 'support.new_ticket',
  limit: TICKETS_PER_DAY,
  windowSeconds: 86_400,
};
const MESSAGE_RULE: LimitRule = {
  name: 'support.message',
  limit: TICKET_MESSAGES_PER_DAY,
  windowSeconds: 86_400,
};

/** Письмо сотрудникам по одному обращению — не чаще этого: переписка из десяти реплик не даёт десять писем. */
const STAFF_MAIL_REPEAT_MS = 15 * 60_000;

/** Сколько знаков текста идёт в письмо: полный текст остаётся в кабинете. */
const MAIL_EXCERPT = 300;

const STAFF_PAGE = 100;
const DAY_MS = 86_400_000;

export interface SupportActor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  readonly email: string;
}

export interface TicketDetail {
  readonly ticket: TicketRow;
  readonly messages: TicketMessageRow[];
}

const CATEGORY_NAME: Record<TicketCategory, string> = {
  bug: 'Ошибка',
  feature: 'Нужна функция',
  money: 'Деньги и выплаты',
  messaging: 'Сообщения MAX',
  calls: 'Звонки',
  other: 'Другое',
};

@Injectable()
export class SupportService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: SupportRepository,
    private readonly billing: BillingService,
    private readonly identity: IdentityService,
    private readonly limits: RateLimitService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('support');
  }

  // --- автор ---

  async create(
    actor: SupportActor,
    input: { cabinet: TicketCabinet; subject: string; category: TicketCategory; body: string },
  ): Promise<TicketDetail> {
    // Кабинет открывает владение карточкой, а не роль: писать «из кабинета партнёра» может только партнёр.
    if (input.cabinet === 'client') await this.billing.requireClientOwnedBy(actor.userId);
    else await this.billing.requirePartnerOwnedBy(actor.userId);

    if ((await this.repository.countOpenByAuthor(actor.userId)) >= TICKETS_OPEN_MAX) {
      throw conflict(
        `Открытых обращений уже ${String(TICKETS_OPEN_MAX)}: дождитесь ответа или закройте решённые`,
      );
    }
    await this.assertWithin(NEW_TICKET_RULE, actor.userId, 'Новых обращений не больше');

    const ticket = await this.repository.createWithMessage({
      authorUserId: actor.userId,
      authorEmail: actor.email,
      cabinet: input.cabinet,
      subject: input.subject,
      category: input.category,
      body: input.body,
    });
    await this.limits.hit(NEW_TICKET_RULE, actor.userId);
    await this.notifyStaff(ticket, `Новое обращение: ${input.subject}`, input.body);
    return { ticket, messages: await this.repository.messages(ticket.id, false) };
  }

  listOwn(actor: SupportActor, filter: Pick<TicketFilter, 'status' | 'limit' | 'offset'>) {
    return this.repository.list({ ...filter, authorUserId: actor.userId });
  }

  async getOwn(actor: SupportActor, id: string): Promise<TicketDetail> {
    const ticket = await this.ownTicket(actor, id);
    return { ticket, messages: await this.repository.messages(ticket.id, false) };
  }

  async reply(actor: SupportActor, id: string, body: string): Promise<TicketDetail> {
    const ticket = await this.ownTicket(actor, id);
    if (ticket.status === 'closed') {
      throw conflict('Обращение закрыто: создайте новое');
    }
    await this.assertWithin(MESSAGE_RULE, actor.userId, 'Сообщений в сутки не больше');
    await this.repository.addMessage({
      ticketId: ticket.id,
      authorUserId: actor.userId,
      side: 'user',
      body,
      internal: false,
      nextStatus: 'open',
      now: new Date(),
    });
    await this.limits.hit(MESSAGE_RULE, actor.userId);
    await this.notifyStaff(ticket, `Ответ в обращении: ${ticket.subject}`, body);
    return this.getOwn(actor, id);
  }

  /** Автор закрывает своё обращение: вопрос решён, возвращаться не нужно. */
  async close(actor: SupportActor, id: string): Promise<TicketDetail> {
    const ticket = await this.ownTicket(actor, id);
    if (ticket.status === 'closed') throw conflict('Обращение уже закрыто');
    await this.repository.setStatus(ticket.id, 'closed', new Date());
    return this.getOwn(actor, id);
  }

  // --- сотрудники ---

  listStaff(filter: TicketFilter) {
    return this.repository.list(filter);
  }

  async getStaff(id: string): Promise<TicketDetail> {
    const ticket = await this.anyTicket(id);
    return { ticket, messages: await this.repository.messages(ticket.id, true) };
  }

  /** Ответ автору либо внутренняя заметка. Закрытому обращению отвечать нельзя, заметку оставить можно. */
  async staffReply(
    actor: SupportActor,
    id: string,
    input: { body: string; internal: boolean },
  ): Promise<TicketDetail> {
    const ticket = await this.anyTicket(id);
    if (!input.internal && ticket.status === 'closed') {
      throw conflict('Обращение закрыто: автор может создать новое');
    }
    await this.repository.addMessage({
      ticketId: ticket.id,
      authorUserId: actor.userId,
      side: 'staff',
      body: input.body,
      internal: input.internal,
      nextStatus: input.internal ? undefined : 'waiting_user',
      now: new Date(),
    });
    if (!input.internal) await this.notifyAuthor(ticket, input.body);
    return this.getStaff(id);
  }

  async setStatus(actor: SupportActor, id: string, status: TicketStatus): Promise<TicketDetail> {
    const ticket = await this.anyTicket(id);
    if (ticket.status === 'closed') throw conflict('Закрытое обращение не открывается снова');
    if (ticket.status !== status) {
      await this.repository.setStatus(ticket.id, status, new Date());
      await this.audit.record({
        action: 'support_ticket.status_changed',
        entityType: 'support_ticket',
        entityId: ticket.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        before: { status: ticket.status },
        after: { status },
      });
    }
    return this.getStaff(id);
  }

  async assign(actor: SupportActor, id: string, toMe: boolean): Promise<TicketDetail> {
    const ticket = await this.anyTicket(id);
    const assignee = toMe ? actor.userId : null;
    if (ticket.assigneeUserId !== assignee) {
      await this.repository.setAssignee(ticket.id, assignee);
      // Взятое обращение «открыто» → «в работе»: очередь показывает, что им уже занимаются.
      if (toMe && ticket.status === 'open') {
        await this.repository.setStatus(ticket.id, 'in_progress', new Date());
      }
      await this.audit.record({
        action: 'support_ticket.assigned',
        entityType: 'support_ticket',
        entityId: ticket.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        before: { assignee_user_id: ticket.assigneeUserId },
        after: { assignee_user_id: assignee },
      });
    }
    return this.getStaff(id);
  }

  /** Фоновая задача: решённые обращения, к которым не вернулись за неделю, закрываются сами. */
  async closeResolved(now: Date): Promise<number> {
    return this.repository.closeResolvedBefore(
      new Date(now.getTime() - TICKET_AUTOCLOSE_DAYS * DAY_MS),
      now,
    );
  }

  // --- внутреннее ---

  private async anyTicket(id: string): Promise<TicketRow> {
    const parsed = safeId(id);
    const ticket = parsed === undefined ? undefined : await this.repository.findById(parsed);
    if (ticket === undefined) throw notFound('Обращение не найдено');
    return ticket;
  }

  /** Чужое обращение неотличимо от несуществующего. */
  private async ownTicket(actor: SupportActor, id: string): Promise<TicketRow> {
    const ticket = await this.anyTicket(id);
    if (ticket.authorUserId !== actor.userId) throw notFound('Обращение не найдено');
    return ticket;
  }

  private async assertWithin(rule: LimitRule, subject: string, text: string): Promise<void> {
    const verdict = await this.limits.check(rule, subject);
    if (!verdict.allowed) {
      throw rateLimited(`${text} ${String(rule.limit)}: попробуйте позже`);
    }
  }

  /** Сотрудникам с подтверждённой почтой; сбой почты обращения не ломает. */
  private async notifyStaff(ticket: TicketRow, subject: string, body: string): Promise<void> {
    try {
      if (!(await this.settings.notifications()).supportStaffEnabled) return;
      const since = new Date(Date.now() - STAFF_MAIL_REPEAT_MS);
      const kind = `ticket_staff:${ticket.id}`;
      for (const role of ['admin', 'support'] as const) {
        const { users } = await this.identity.listUsers({
          role,
          status: 'active',
          limit: STAFF_PAGE,
          offset: 0,
        });
        for (const user of users) {
          if (user.emailConfirmedAt === null) continue;
          if (await this.mail.hasRecent(kind, user.email, since)) continue;
          await this.mail.enqueue({
            recipient: user.email,
            kind,
            subject: `Zvonix: ${subject}`,
            body: [
              `${ticket.cabinet === 'client' ? 'Клиент' : 'Партнёр'} ${ticket.authorEmail}, категория «${CATEGORY_NAME[ticket.category]}».`,
              '',
              excerpt(body),
              '',
              'Ответить: кабинет → «Обращения».',
            ].join('\n'),
          });
        }
      }
    } catch (cause) {
      this.logger.error('Письмо сотрудникам об обращении не поставлено', cause, {
        ticket_id: ticket.id,
      });
    }
  }

  private async notifyAuthor(ticket: TicketRow, body: string): Promise<void> {
    try {
      await this.mail.enqueue({
        recipient: ticket.authorEmail,
        kind: `ticket_reply:${ticket.id}`,
        subject: `Zvonix: ответ на обращение «${ticket.subject}»`,
        body: [excerpt(body), '', 'Продолжить разговор: кабинет → «Поддержка».'].join('\n'),
      });
    } catch (cause) {
      this.logger.error('Письмо автору об ответе не поставлено', cause, { ticket_id: ticket.id });
    }
  }
}

/** Начало текста для письма: полный разговор остаётся в кабинете. */
function excerpt(body: string): string {
  return body.length <= MAIL_EXCERPT ? body : `${body.slice(0, MAIL_EXCERPT)}…`;
}

function safeId(id: string): Id<'supportTicket'> | undefined {
  try {
    return parseId(id, 'supportTicket');
  } catch {
    return undefined;
  }
}
