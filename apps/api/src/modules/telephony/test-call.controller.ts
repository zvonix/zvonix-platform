/**
 * Тестовый звонок с SIM — партнёру со своих карт, администратору с любых
 * ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md), docs/api/partner.md,
 * docs/api/telephony.md).
 *
 * Запуск отвечает `202` сразу: дозвон идёт до сорока секунд, итог кабинет узнаёт
 * повторным чтением записи.
 */

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseId, TEST_CALL_STALE_AFTER_MS, type TestCallStatus } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { testCallSchema } from './schemas.js';
import type { TestCallRow } from './test-call.repository.js';
import { TestCallService } from './test-call.service.js';

interface TestCallView {
  readonly id: string;
  readonly sim_card_id: string;
  readonly gateway_id: string;
  readonly port_number: number;
  readonly destination: string;
  readonly status: TestCallStatus;
  readonly hangup_cause: string | null;
  readonly sip_status: string | null;
  readonly sip_phrase: string | null;
  /** Шлюз сообщал «набираю» — звонок дошёл до сети оператора. */
  readonly rang: boolean;
  readonly talk_seconds: number | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

@Controller()
export class TestCallController {
  constructor(
    private readonly testCalls: TestCallService,
    private readonly billing: BillingService,
  ) {}

  @Cabinets('partner')
  @Post('partner/sim-cards/:id/test-call')
  @HttpCode(202)
  async partnerStart(
    @Param('id') id: string,
    @Body(zodBody(testCallSchema)) body: z.infer<typeof testCallSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ test_call: TestCallView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const row = await this.testCalls.start(parseId(id, 'simCard'), body.destination, {
      userId: actor.userId,
      role: actor.role,
      partnerId: partner.id,
    });
    return { test_call: toTestCallView(row) };
  }

  @Cabinets('partner')
  @Get('partner/test-calls/:id')
  async partnerGet(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ test_call: TestCallView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const row = await this.testCalls.get(parseId(id, 'testCall'), partner.id);
    return { test_call: toTestCallView(row) };
  }

  /** Администратор проверяет любую карту — когда партнёр пишет «не работает». */
  @Roles('admin')
  @Post('sim-cards/:id/test-call')
  @HttpCode(202)
  async adminStart(
    @Param('id') id: string,
    @Body(zodBody(testCallSchema)) body: z.infer<typeof testCallSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ test_call: TestCallView }> {
    const row = await this.testCalls.start(parseId(id, 'simCard'), body.destination, {
      userId: actor.userId,
      role: actor.role,
    });
    return { test_call: toTestCallView(row) };
  }

  @Roles('admin', 'support')
  @Get('test-calls/:id')
  async adminGet(@Param('id') id: string): Promise<{ test_call: TestCallView }> {
    const row = await this.testCalls.get(parseId(id, 'testCall'));
    return { test_call: toTestCallView(row) };
  }
}

/**
 * Вид пробы. Проба, застрявшая в `dialing` дольше срока, показывается как `unknown`:
 * итог потерян, и «звоним» было бы неправдой. В базе она закроется при следующей пробе.
 */
function toTestCallView(row: TestCallRow, now: Date = new Date()): TestCallView {
  const stale =
    row.status === 'dialing' && now.getTime() - row.createdAt.getTime() > TEST_CALL_STALE_AFTER_MS;
  return {
    id: row.id,
    sim_card_id: row.simCardId,
    gateway_id: row.gatewayId,
    port_number: row.portNumber,
    destination: row.destination,
    status: stale ? 'unknown' : row.status,
    hangup_cause: row.hangupCause,
    sip_status: row.sipStatus,
    sip_phrase: row.sipPhrase,
    rang: row.rangAt !== null,
    talk_seconds: row.talkSeconds,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}
