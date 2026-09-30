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
  type UserRole,
} from '@zvonix/shared';
import { randomInt } from 'node:crypto';
import type { Executor } from '@zvonix/db';
import { DatabaseService } from '../../infra/database.service.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import type { ApplicationId, ApplicationRow, UserId } from '../identity/identity.repository.js';
import { IdentityService, type Principal, type RequestMeta } from '../identity/identity.service.js';
import { applicationSchema, type ApplicationInput } from '../identity/schemas.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { applicationApprovedLetter, applicationRejectedLetter } from './letters.js';

/** Сколько заявок разбирает один проход: больше — дождутся следующего. */
const AUTO_APPROVE_BATCH = 100;

/**
 * Псевдоним для партнёра, одобренного площадкой: клиенты видят только его. Случайный
 * номер, а не счётчик: счётчик сталкивался бы с псевдонимами, заданными вручную.
 */
function generatedAlias(): string {
  return `Партнёр ${String(randomInt(100_000, 1_000_000))}`;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly identity: IdentityService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
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
    // Второй кабинет — по настройке площадки (владелец, 2026-09-29).
    const allowed = await this.settings.cabinets();
    if (
      (input.cabinet === 'client' && owned.partner !== undefined && !allowed.partnerMayAddClient) ||
      (input.cabinet === 'partner' && owned.client !== undefined && !allowed.clientMayAddPartner)
    ) {
      throw permissionDenied('Площадка сейчас не подключает второй кабинет');
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

    // Почта уже подтверждена, а площадка допускает без проверки — решение сразу,
    // не дожидаясь фоновой задачи.
    if ((await this.autoApprove()) > 0) {
      const fresh = await this.identity.applicationsOf(actor.userId);
      return fresh.find((row) => row.id === application.id) ?? application;
    }
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
    return this.database.db.transaction((tx) =>
      this.approveLocked(tx, id, {
        actor: { userId: actor.userId, role: actor.role },
        displayName: options.displayName,
        partnerStatus: 'pending',
        meta,
      }),
    );
  }

  /**
   * Одобряет поданные заявки сама — партнёров и клиентов по отдельным настройкам
   * (`partners.auto_approve` — владелец 2026-09-29, `clients.auto_approve` — 2026-09-30).
   * Клиент не обязательно служба такси: заявку может подать человек, который звонит друзьям.
   *
   * Тем же путём, что одобрение человеком: карточка, открытый вход, решение, журнал,
   * письмо. Отличий два: партнёр сразу `verified` — «без подтверждения админа» значит
   * и допуск к работе, иначе вход открылся бы, а шлюзы всё равно не пустило бы; и в журнале
   * вместо администратора — пусто: решение приняла площадка по настройке.
   *
   * Почта по-прежнему должна быть подтверждена: иначе кабинет получал бы любой, кто
   * вписал чужой адрес. Идемпотентна и догоняюща (ADR-0020): зовётся фоновой задачей
   * раз в минуту и сразу после подачи заявки; включили настройку — разберёт и то, что
   * накопилось. Возвращает число одобренных.
   */
  async autoApprove(): Promise<number> {
    const [partners, clients] = await Promise.all([
      this.settings.partners(),
      this.settings.clients(),
    ]);
    if (!partners.autoApprove && !clients.autoApprove) return 0;

    const { rows } = await this.identity.listApplications({
      status: 'submitted',
      limit: AUTO_APPROVE_BATCH,
      offset: 0,
    });
    let approved = 0;
    for (const { application, applicant } of rows) {
      const allowed = application.kind === 'partner' ? partners.autoApprove : clients.autoApprove;
      if (!allowed || applicant.emailConfirmedAt === null) continue;
      try {
        await this.database.db.transaction((tx) =>
          this.approveLocked(tx, application.id, {
            actor: null,
            displayName: generatedAlias(),
            partnerStatus: 'verified',
            meta: { ip: null, userAgent: null },
          }),
        );
        approved += 1;
      } catch (cause) {
        // Одна заявка не должна останавливать остальные: её решил человек за это время,
        // или совпал псевдоним — следующий проход попробует снова с другим.
        if (!(cause instanceof DomainError)) throw cause;
      }
    }
    return approved;
  }

  private async approveLocked(
    tx: Executor,
    id: ApplicationId,
    decision: {
      actor: { userId: UserId; role: UserRole } | null;
      displayName: string | undefined;
      partnerStatus: 'pending' | 'verified';
      meta: RequestMeta;
    },
  ): Promise<ApplicationRow> {
    const { actor, meta } = decision;
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
      // Клиент работает сразу, но без разрешённого минуса: пока не пополнит счёт, звонить
      // ему нечем — автоматический допуск денег не открывает.
      const client = await this.billing.createClient(
        {
          ownerUserId: applicant.id,
          name: parsed.answers.companyName ?? applicant.fullName,
          overdraftLimit: Money.ZERO,
          status: 'active',
        },
        actor,
        tx,
      );
      cardId = client.id;
    } else {
      if (decision.displayName === undefined) {
        throw validationFailed('Для партнёра нужен псевдоним — под ним его увидят клиенты', {
          details: { field: 'displayName' },
        });
      }
      // Одобренный человеком партнёр — `pending`, как и заведённый вручную: звонки на его
      // шлюзы пойдут после проверки оборудования. Одобренный площадкой по настройке —
      // сразу `verified`.
      const partner = await this.billing.createPartner(
        {
          ownerUserId: applicant.id,
          name: applicant.fullName,
          displayName: decision.displayName,
          status: decision.partnerStatus,
        },
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
        decidedByUserId: actor?.userId ?? null,
        decidedAt: new Date(),
        decisionNote: actor === null ? 'Одобрено площадкой автоматически' : null,
      },
      tx,
    );

    await this.audit.record(
      {
        action: 'application.approved',
        entityType: 'application',
        entityId: id,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? null,
        before: { status: 'submitted', user_status: applicant.status },
        after: {
          status: 'approved',
          cabinet: application.kind,
          card_id: cardId,
          user_status: admitted.status,
          automatic: actor === null,
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
