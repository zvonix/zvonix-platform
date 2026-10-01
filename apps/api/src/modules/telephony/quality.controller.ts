/**
 * Качество терминации и пороги отключения: человеческая часть (ADR-0027).
 */

import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { FAILURE_SCOPES, parseId, validationFailed, type FailureScope } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import type { FailureThresholdRow } from './quality.repository.js';
import { QualityService, type QualityView } from './quality.service.js';
import { failureThresholdSchema } from './schemas.js';

/** Окно наблюдения по умолчанию: сутки. Меньше — шум, больше — поздно. */
const DEFAULT_WINDOW_MINUTES = 1440;
const MAX_WINDOW_MINUTES = 44_640;

interface QualityResponse {
  readonly subject_id: string;
  /** Номер SIM или название шлюза. */
  readonly subject_name: string;
  readonly subject_status: string;
  readonly partner_id: string;
  readonly partner_name: string;
  readonly attempts: number;
  readonly answered: number;
  readonly network_failures: number;
  /** Доля отвеченных в десятитысячных: 4210 значит 42,1%. */
  readonly asr_basis_points: number;
  readonly acd_seconds: number;
}

interface ThresholdResponse {
  readonly scope: string;
  readonly failures: number;
  readonly window_minutes: number;
}

@Controller()
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  /**
   * Качество SIM за окно.
   *
   * ASR и ACD — **для человека**: автомат на них не смотрит. Низкий ASR чаще означает
   * холодную базу клиента, чем неисправную SIM, и отключать за это нельзя (ADR-0027).
   */
  @Roles('admin', 'support')
  @Get('quality/sims')
  async sims(
    @Query('windowMinutes') windowMinutes?: string,
    @Query('partnerId') partnerId?: string,
  ): Promise<{ sims: QualityResponse[] }> {
    const rows = await this.quality.sims(
      since(windowMinutes),
      partnerId === undefined ? undefined : parseId(partnerId, 'partner'),
    );
    return { sims: rows.map(toQualityView) };
  }

  @Roles('admin', 'support')
  @Get('quality/gateways')
  async gateways(
    @Query('windowMinutes') windowMinutes?: string,
    @Query('partnerId') partnerId?: string,
  ): Promise<{ gateways: QualityResponse[] }> {
    const rows = await this.quality.gateways(
      since(windowMinutes),
      partnerId === undefined ? undefined : parseId(partnerId, 'partner'),
    );
    return { gateways: rows.map(toQualityView) };
  }

  @Roles('admin', 'support')
  @Get('failure-thresholds')
  async listThresholds(): Promise<{ thresholds: ThresholdResponse[] }> {
    const rows = await this.quality.listThresholds();
    return { thresholds: rows.map(toThresholdView) };
  }

  /**
   * Задаёт порог области целиком.
   *
   * `PUT` по области, а не `POST` с идентификатором: порог на область ровно один,
   * и заводить второй означало бы, что срабатывает прочитанный первым.
   */
  @Roles('admin')
  @Put('failure-thresholds/:scope')
  async setThreshold(
    @Param('scope') scope: string,
    @Body(zodBody(failureThresholdSchema)) body: z.infer<typeof failureThresholdSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ threshold: ThresholdResponse }> {
    const row = await this.quality.setThreshold(
      { scope: parseScope(scope), failures: body.failures, windowMinutes: body.windowMinutes },
      actor.userId,
      actor.role,
    );
    return { threshold: toThresholdView(row) };
  }

  @Roles('admin')
  @Delete('failure-thresholds/:scope')
  async removeThreshold(
    @Param('scope') scope: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ threshold: ThresholdResponse }> {
    const row = await this.quality.removeThreshold(parseScope(scope), actor.userId, actor.role);
    return { threshold: toThresholdView(row) };
  }
}

function parseScope(value: string): FailureScope {
  const scope = FAILURE_SCOPES.find((candidate) => candidate === value);
  if (scope === undefined) {
    // Канала здесь нет намеренно: автоматически отключать платящего клиента — решение
    // с прямыми последствиями для выручки (ADR-0027).
    throw validationFailed(`Область порога — одна из: ${FAILURE_SCOPES.join(', ')}`);
  }
  return scope;
}

/** Начало окна наблюдения. Скользящее: неисправность не знает о полуночи. */
function since(windowMinutes: string | undefined): Date {
  const requested = windowMinutes === undefined ? DEFAULT_WINDOW_MINUTES : Number(windowMinutes);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_WINDOW_MINUTES) {
    throw validationFailed('Окно наблюдения — целое число минут от 1 до 44640');
  }
  return new Date(Date.now() - requested * 60_000);
}

function toQualityView(row: QualityView): QualityResponse {
  return {
    subject_id: row.subjectId,
    subject_name: row.subjectName,
    subject_status: row.subjectStatus,
    partner_id: row.partnerId,
    partner_name: row.partnerName,
    attempts: row.attempts,
    answered: row.answered,
    network_failures: row.networkFailures,
    asr_basis_points: row.asrBasisPoints,
    acd_seconds: row.acdSeconds,
  };
}

function toThresholdView(row: FailureThresholdRow): ThresholdResponse {
  return { scope: row.scope, failures: row.failures, window_minutes: row.windowMinutes };
}
