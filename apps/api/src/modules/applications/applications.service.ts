/**
 * Решение по заявке на кабинет
 * ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Отдельный модуль, потому что решение — это две области сразу: заявка и учётная
 * запись принадлежат модулю учётных записей, карточка клиента или партнёра — биллингу.
 * Оба дают свои методы с транзакцией вызывающего, и одобрение складывает их в одну:
 * либо карточка есть, вход открыт, заявка одобрена и письмо в очереди — либо ничего.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  DomainError,
  isStaffRole,
  Money,
  notFound,
  permissionDenied,
  validationFailed,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import type { ApplicationId, ApplicationRow } from '../identity/identity.repository.js';
import { IdentityService, type Principal, type RequestMeta } from '../identity/identity.service.js';
import { applicationSchema, type ApplicationInput } from '../identity/schemas.js';
import { MailService } from '../mail/mail.service.js';
import { applicationApprovedLetter, applicationRejectedLetter } from './letters.js';

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly identity: IdentityService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  /**
   * Заявка вошедшего участника на второй кабинет.
   *
   * Кабинет, который уже есть, заявкой не просится — `409`: одобрение завело бы вторую
   * карточку, а её не пустит уникальный владелец. Вторая открытая заявка того же вида —
   * тоже `409`, её держит частичный уникальный индекс.
   */
  async submitOwn(
    actor: Principal,
    input: ApplicationInput,
    meta: RequestMeta,
  ): Promise<ApplicationRow> {
    if (isStaffRole(actor.role)) {
      throw permissionDenied(
        'Сотрудник площадки кабинетов не имеет — для кабинета нужна отдельная учётная запись',
      );
    }
    const owned = await this.billing.cabinetsOf(actor.userId);
    if (owned[input.cabinet] !== undefined) {
      throw conflict('Этот кабинет у вас уже подключён');
    }

    let application: ApplicationRow;
    try {
      application = await this.identity.createApplication(actor.userId, input);
    } catch (cause) {
      if (cause instanceof DomainError && cause.code === 'conflict') {
        throw conflict('Заявка на этот кабинет уже ждёт решения администратора');
      }
      throw cause;
    }

    await this.audit.record({
      action: 'application.submitted',
      entityType: 'application',
      entityId: application.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { cabinet: application.kind },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return application;
  }

  /** Заявитель отзывает свою заявку, пока по ней не решили. */
  async withdrawOwn(
    actor: Principal,
    id: ApplicationId,
    meta: RequestMeta,
  ): Promise<ApplicationRow> {
    return this.database.db.transaction(async (tx) => {
      const { application } = await this.identity.lockApplication(id, tx);
      // Чужая заявка и несуществующая отвечают одинаково: иначе по разнице ответов
      // перебираются чужие заявки.
      if (application.userId !== actor.userId) throw notFound('Заявка не найдена');
      if (application.status !== 'submitted') {
        throw conflict('Решение по заявке уже принято — отозвать её нельзя');
      }

      const withdrawn = await this.identity.decideApplication(
        id,
        { status: 'withdrawn', decidedByUserId: null, decidedAt: null, decisionNote: null },
        tx,
      );
      await this.audit.record(
        {
          action: 'application.withdrawn',
          entityType: 'application',
          entityId: id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: { status: 'submitted' },
          after: { status: 'withdrawn' },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return withdrawn;
    });
  }

  /**
   * Одобрение: карточка, открытый вход, решение, журнал и письмо — одна транзакция.
   *
   * Заявка запирается первой: два администратора, одобряющие одну заявку, иначе
   * завели бы две карточки. Почта заявителя должна быть подтверждена — иначе
   * письмо об одобрении уйдёт человеку, который адресом, возможно, не владеет.
   */
  async approve(
    actor: Principal,
    id: ApplicationId,
    options: { displayName?: string | undefined },
    meta: RequestMeta,
  ): Promise<ApplicationRow> {
    return this.database.db.transaction(async (tx) => {
      const { application, applicant } = await this.identity.lockApplication(id, tx);
      if (application.status !== 'submitted') {
        throw conflict('Решение по заявке уже принято');
      }
      if (applicant.emailConfirmedAt === null) {
        throw conflict('Заявитель ещё не подтвердил почту — одобрить заявку пока нельзя');
      }
      if (applicant.status === 'suspended' || applicant.status === 'disabled') {
        throw conflict('Учётная запись заявителя приостановлена или закрыта');
      }
      if (isStaffRole(applicant.role)) {
        throw conflict('Сотрудник площадки не может быть клиентом или партнёром');
      }

      const parsed = applicationSchema.parse({
        cabinet: application.kind,
        answers: application.answers,
      });
      let cardId: string;
      if (parsed.cabinet === 'client') {
        // Клиент работает сразу: решение о нём уже принял человек, одобрив заявку.
        const client = await this.billing.createClient(
          {
            ownerUserId: applicant.id,
            name: parsed.answers.companyName,
            overdraftLimit: Money.ZERO,
            status: 'active',
          },
          actor,
          tx,
        );
        cardId = client.id;
      } else {
        if (options.displayName === undefined) {
          throw validationFailed('Для партнёра нужен псевдоним — под ним его увидят клиенты', {
            details: { field: 'displayName' },
          });
        }
        // Партнёр — `pending`, как и заведённый вручную: звонки на его шлюзы пойдут
        // после проверки оборудования.
        const partner = await this.billing.createPartner(
          { ownerUserId: applicant.id, name: applicant.fullName, displayName: options.displayName },
          actor,
          tx,
        );
        cardId = partner.id;
      }

      const admitted = await this.identity.admitApplicant(applicant, tx);
      const decided = await this.identity.decideApplication(
        id,
        {
          status: 'approved',
          decidedByUserId: actor.userId,
          decidedAt: new Date(),
          decisionNote: null,
        },
        tx,
      );

      await this.audit.record(
        {
          action: 'application.approved',
          entityType: 'application',
          entityId: id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: { status: 'submitted', user_status: applicant.status },
          after: {
            status: 'approved',
            cabinet: application.kind,
            card_id: cardId,
            user_status: admitted.status,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      await this.mail.enqueue(
        {
          recipient: applicant.email,
          ...applicationApprovedLetter(this.config.WEB_BASE_URL, application.kind),
        },
        tx,
      );
      return decided;
    });
  }

  /**
   * Отказ с причиной. Первая заявка: вход так и остаётся закрытым. Вторая: кабинет,
   * который уже был, работает дальше — отказ касается только нового.
   */
  async reject(
    actor: Principal,
    id: ApplicationId,
    note: string,
    meta: RequestMeta,
  ): Promise<ApplicationRow> {
    return this.database.db.transaction(async (tx) => {
      const { application, applicant } = await this.identity.lockApplication(id, tx);
      if (application.status !== 'submitted') {
        throw conflict('Решение по заявке уже принято');
      }

      const decided = await this.identity.decideApplication(
        id,
        {
          status: 'rejected',
          decidedByUserId: actor.userId,
          decidedAt: new Date(),
          decisionNote: note,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'application.rejected',
          entityType: 'application',
          entityId: id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: { status: 'submitted' },
          after: { status: 'rejected', cabinet: application.kind, note },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      await this.mail.enqueue(
        { recipient: applicant.email, ...applicationRejectedLetter(application.kind, note) },
        tx,
      );
      return decided;
    });
  }
}
