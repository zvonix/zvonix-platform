/**
 * Узел сам сообщает, кто на нём зарегистрирован
 * ([ADR-0114](../../../../../docs/adr/0114-uzel-sam-soobshchaet-registracii.md), docs/api/node.md).
 *
 * Площадка ходит в ESL только на своей машине (ADR-0051, ADR-0055), поэтому об узле на отдельном сервере
 * она узнаёт лишь так: пульс узла раз в 30 секунд присылает ответ FreeSWITCH на `show registrations as json`.
 * Без этого GOIP, вошедший на такой узел, в кабинете навсегда «не на связи» (владелец, 2026-11-12).
 */

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { readRegistrations, RegistrationsService } from './registrations.service.js';
import { registrationsReportSchema } from './schemas.js';

@Controller('node')
export class NodeRegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Machine('node')
  @Post('registrations')
  @HttpCode(200)
  async report(
    @Body(zodBody(registrationsReportSchema)) body: z.infer<typeof registrationsReportSchema>,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ recorded: number }> {
    const recorded = await this.registrations.record(
      parseId(machine.ownerId, 'node'),
      readRegistrations(body),
      new Date(),
    );
    return { recorded };
  }
}
