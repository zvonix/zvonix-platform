/**
 * Аккаунты MAX ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Партнёр видит и меняет только свои, и только то, что ему положено знать: ни провайдера, ни
 * идентификатора инстанса, ни ключа в ответах нет. Сотрудники видят все аккаунты с названием партнёра.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Money, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { MessengerAccountRow } from './messaging.repository.js';
import { effectiveLimits } from './warmup.js';
import { MessagingService } from './messaging.service.js';
import {
  createAccountSchema,
  registerAccountSchema,
  sendPasswordSchema,
  updateAccountSchema,
  warmupSchema,
} from './schemas.js';

interface AccountView {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  /** Почему недоступен: `suspended`, `blocked`, `logged_out`; пусто — рабочий или ждёт входа. */
  readonly state_reason: string | null;
  /** Номер, под которым аккаунт вошёл в MAX; пусто, пока QR-код не отсканирован. */
  readonly phone: string | null;
  /** Назначенный тариф; пусто — аккаунт идёт за тарифом по умолчанию. Цена и лимиты ниже — действующие. */
  readonly tariff_id: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
  /** Автопрогрев и равномерная отправка включены. */
  readonly warmup_enabled: boolean;
  /** Номер суток прогрева с нуля; пусто — прогрева нет. */
  readonly warmup_day: number | null;
  /** Сколько сообщений за сутки аккаунту разрешено сейчас; пусто — без ограничения. */
  readonly daily_limit_now: number | null;
  readonly state_checked_at: string | null;
  readonly created_at: string;
}

const toView = (row: MessengerAccountRow, now: Date = new Date()): AccountView => ({
  id: row.id,
  label: row.label,
  status: row.status,
  state_reason: row.stateReason,
  phone: row.phone,
  tariff_id: row.tariffId,
  price: row.price === null ? null : Money.format(row.price),
  limit_per_minute: row.limitPerMinute,
  limit_per_day: row.limitPerDay,
  warmup_enabled: row.warmupEnabled,
  warmup_day: effectiveLimits(row, now).warmupDay,
  daily_limit_now: effectiveLimits(row, now).daily,
  state_checked_at: row.stateCheckedAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
});

@Controller()
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
  ) {}

  /** Аккаунты партнёра и признак «продукт включён»: выключенный раздел показывает это, а не пустоту. */
  @Cabinets('partner')
  @Get('partner/messenger/accounts')
  async listOwn(
    @CurrentUser() actor: Principal,
  ): Promise<{ enabled: boolean; accounts: AccountView[] }> {
    const [rows, config] = await Promise.all([
      this.messaging.listOwn(actor.userId),
      this.settings.messaging(),
    ]);
    return { enabled: config.enabled, accounts: rows.map((row) => toView(row)) };
  }

  /** Партнёр заводит аккаунт; дальше — QR-код. `201` с аккаунтом в состоянии «ждёт входа». */
  @Cabinets('partner')
  @Post('partner/messenger/accounts')
  async createOwn(
    @CurrentUser() actor: Principal,
    @Body(zodBody(createAccountSchema)) body: z.infer<typeof createAccountSchema>,
  ): Promise<{ account: AccountView }> {
    const row = await this.messaging.createOwn(
      { userId: actor.userId, role: actor.role },
      body.label,
    );
    return { account: toView(row) };
  }

  /**
   * QR-код для входа. `status: "qr"` — картинка (`image` — готовая ссылка `data:`), `authorized` —
   * уже вошёл, `unavailable` — подождите и повторите. Клиент запрашивает заново раз в несколько секунд.
   */
  @Cabinets('partner')
  @Get('partner/messenger/accounts/:id/qr')
  async qr(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
  ): Promise<{ status: 'qr' | 'authorized' | 'password' | 'unavailable'; image?: string }> {
    const result = await this.messaging.qrOwn(actor.userId, id);
    if (result.kind === 'qr') {
      return { status: 'qr', image: `data:image/png;base64,${result.image}` };
    }
    return { status: result.kind === 'password_required' ? 'password' : result.kind };
  }

  /**
   * Облачный пароль MAX, когда после сканирования QR вход ждёт его (`status: "password"` у QR). Пароль
   * передаётся провайдеру и не сохраняется. `204` — вход завершён; `400` — неверный пароль.
   */
  @Cabinets('partner')
  @HttpCode(204)
  @Post('partner/messenger/accounts/:id/password')
  async sendPassword(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(sendPasswordSchema)) body: z.infer<typeof sendPasswordSchema>,
  ): Promise<void> {
    await this.messaging.sendPasswordOwn(actor.userId, id, body.password);
  }

  @Cabinets('partner')
  @Patch('partner/messenger/accounts/:id')
  async updateOwn(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(updateAccountSchema)) body: z.infer<typeof updateAccountSchema>,
  ): Promise<{ account: AccountView }> {
    const row = await this.messaging.updateOwn({ userId: actor.userId, role: actor.role }, id, {
      label: body.label,
    });
    return { account: toView(row) };
  }

  @Cabinets('partner')
  @Delete('partner/messenger/accounts/:id')
  @HttpCode(204)
  async retireOwn(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.messaging.retireOwn({ userId: actor.userId, role: actor.role }, id);
  }

  /** Все аккаунты площадки — сотрудникам: чьи, в каком состоянии, по какой цене. */
  @Roles('admin', 'support')
  @Get('messenger/accounts')
  async listAll(): Promise<{
    accounts: (AccountView & { partner_id: string; partner_name: string })[];
  }> {
    const rows = await this.messaging.listAll();
    return {
      accounts: rows.map(({ account, partnerName }) => ({
        ...toView(account),
        partner_id: account.partnerId,
        partner_name: partnerName,
      })),
    };
  }

  /** Ручное заведение: данные готового инстанса. Ключа в ответе нет. */
  /**
   * Проверка сохранённого партнёрского ключа провайдера: что ключ принят и сколько аккаунтов заведено.
   * Ничего не создаёт и денег не тратит; провайдер в ответе не называется.
   */
  @Roles('admin')
  @HttpCode(200)
  @Post('messenger/provider/test')
  async testProvider(): Promise<{ ok: boolean; message: string }> {
    const result = await this.messaging.checkProvider();
    switch (result.state) {
      case 'ok':
        return {
          ok: true,
          message: `Ключ принят. Аккаунтов у провайдера уже заведено: ${String(result.instances)}.`,
        };
      case 'no_key':
        return { ok: false, message: 'Ключ не задан: впишите его и сохраните настройки.' };
      case 'rejected':
        return {
          ok: false,
          message: 'Провайдер ключ не принял. Проверьте ключ и адрес, сохраните настройки.',
        };
      case 'unreachable':
        return { ok: false, message: 'Нет связи с провайдером. Повторите позже.' };
    }
  }

  @Roles('admin')
  @Post('messenger/accounts')
  async register(
    @CurrentUser() actor: Principal,
    @Body(zodBody(registerAccountSchema)) body: z.infer<typeof registerAccountSchema>,
  ): Promise<{ account: AccountView }> {
    const row = await this.messaging.registerByAdmin(
      { userId: actor.userId, role: actor.role },
      {
        partnerId: parseId(body.partnerId, 'partner'),
        label: body.label,
        instanceId: body.instanceId,
        token: body.token,
        apiUrl: body.apiUrl,
      },
    );
    return { account: toView(row) };
  }

  /** Автопрогрев аккаунта: включить или выключить (ADR-0078). */
  @Roles('admin')
  @Patch('messenger/accounts/:id/warmup')
  async setWarmup(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(warmupSchema)) body: z.infer<typeof warmupSchema>,
  ): Promise<{ account: AccountView }> {
    const row = await this.messaging.setWarmup(
      { userId: actor.userId, role: actor.role },
      id,
      body.enabled,
    );
    return { account: toView(row) };
  }

  @Roles('admin')
  @Delete('messenger/accounts/:id')
  @HttpCode(204)
  async retire(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.messaging.retireByAdmin({ userId: actor.userId, role: actor.role }, id);
  }
}
