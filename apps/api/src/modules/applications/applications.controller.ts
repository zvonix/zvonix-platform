/**
 * Заявки на кабинет ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Два контура. `/applications/*` — очередь администратора: читают администратор
 * и поддержка, решает только администратор. `/me/applications` — заявки самого
 * человека: идентификатор заявителя здесь не принимается, он выводится из сессии.
 * Первая заявка подаётся вместе с регистрацией (`POST /auth/register`), здесь —
 * вторая, из уже открытого кабинета.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { isStaffRole, parseId, type ApplicationStatus, type Cabinet } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser, Meta } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import type { ApplicationRow } from '../identity/identity.repository.js';
import { IdentityService, type Principal, type RequestMeta } from '../identity/identity.service.js';
import {
  applicationListQuerySchema,
  applicationSchema,
  approveApplicationSchema,
  rejectApplicationSchema,
} from '../identity/schemas.js';
import { ApplicationsService } from './applications.service.js';

/** Заявка так, как её видит сам заявитель. */
interface ApplicationView {
  readonly id: string;
  readonly cabinet: Cabinet;
  readonly status: ApplicationStatus;
  readonly answers: unknown;
  readonly created_at: string;
  readonly decided_at: string | null;
  /** Причина отказа — та же, что ушла письмом. */
  readonly decision_note: string | null;
}

/** Заявка в очереди администратора: с тем, кто её подал. */
interface QueuedApplicationView extends ApplicationView {
  readonly applicant: {
    readonly id: string;
    readonly email: string;
    readonly full_name: string;
    readonly status: string;
    /** Одобрить можно только после подтверждения почты. */
    readonly email_confirmed: boolean;
  };
}

function toView(row: ApplicationRow): ApplicationView {
  return {
    id: row.id,
    cabinet: row.kind,
    status: row.status,
    answers: row.answers,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_note: row.decisionNote,
  };
}

@Controller()
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly identity: IdentityService,
  ) {}

  @Roles('admin', 'support')
  @Get('applications')
  async list(
    @Query(zodQuery(applicationListQuerySchema)) query: z.infer<typeof applicationListQuerySchema>,
  ): Promise<{ applications: QueuedApplicationView[]; total: number }> {
    const found = await this.identity.listApplications({
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return {
      applications: found.rows.map(({ application, applicant }) => ({
        ...toView(application),
        applicant: {
          id: applicant.id,
          email: applicant.email,
          full_name: applicant.fullName,
          status: applicant.status,
          email_confirmed: applicant.emailConfirmedAt !== null,
        },
      })),
      total: found.total,
    };
  }

  @Roles('admin')
  @Post('applications/:id/approve')
  @HttpCode(200)
  async approve(
    @Param('id') id: string,
    @Body(zodBody(approveApplicationSchema)) body: z.infer<typeof approveApplicationSchema>,
    @CurrentUser() actor: Principal,
    @Meta() meta: RequestMeta,
  ): Promise<{ application: ApplicationView }> {
    const decided = await this.applications.approve(
      actor,
      parseId(id, 'application'),
      { displayName: body.displayName },
      meta,
    );
    return { application: toView(decided) };
  }

  @Roles('admin')
  @Post('applications/:id/reject')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @Body(zodBody(rejectApplicationSchema)) body: z.infer<typeof rejectApplicationSchema>,
    @CurrentUser() actor: Principal,
    @Meta() meta: RequestMeta,
  ): Promise<{ application: ApplicationView }> {
    const decided = await this.applications.reject(
      actor,
      parseId(id, 'application'),
      body.note,
      meta,
    );
    return { application: toView(decided) };
  }

  /** Свои заявки. Сотруднику — пусто: заявок на кабинет он не подаёт. */
  @Get('me/applications')
  async mine(@CurrentUser() actor: Principal): Promise<{ applications: ApplicationView[] }> {
    if (isStaffRole(actor.role)) return { applications: [] };
    const rows = await this.identity.applicationsOf(actor.userId);
    return { applications: rows.map(toView) };
  }

  @Post('me/applications')
  async submit(
    @Body(zodBody(applicationSchema)) body: z.infer<typeof applicationSchema>,
    @CurrentUser() actor: Principal,
    @Meta() meta: RequestMeta,
  ): Promise<{ application: ApplicationView }> {
    return { application: toView(await this.applications.submitOwn(actor, body, meta)) };
  }

  @Post('me/applications/:id/withdraw')
  @HttpCode(200)
  async withdraw(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Meta() meta: RequestMeta,
  ): Promise<{ application: ApplicationView }> {
    const withdrawn = await this.applications.withdrawOwn(actor, parseId(id, 'application'), meta);
    return { application: toView(withdrawn) };
  }
}
