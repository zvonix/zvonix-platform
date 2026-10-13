/**
 * Сертификат кабинета ([ADR-0083](../../../../../docs/adr/0083-sertifikat-v-nastroykah.md)): только администратор.
 *
 * Состояние читается, действия — заявки службе обновления; сам обработчик ничего в системе не меняет.
 */

import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { CertificateService, type CertificateView } from './certificate.service.js';
import { certificateAutoSchema } from './schemas.js';
import type { QueuedRequest } from './updates.service.js';

@Controller()
export class CertificateController {
  constructor(private readonly certificate: CertificateService) {}

  @Roles('admin')
  @Get('certificate')
  view(): Promise<CertificateView> {
    return this.certificate.view();
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('certificate/check')
  async check(@CurrentUser() actor: Principal): Promise<{ request: QueuedRequest }> {
    return { request: await this.certificate.check(actor) };
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('certificate/issue')
  async issue(@CurrentUser() actor: Principal): Promise<{ request: QueuedRequest }> {
    return { request: await this.certificate.issue(actor) };
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('certificate/auto')
  async auto(
    @CurrentUser() actor: Principal,
    @Body(zodBody(certificateAutoSchema)) body: z.infer<typeof certificateAutoSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return { request: await this.certificate.setAuto(actor, body.enabled) };
  }
}
