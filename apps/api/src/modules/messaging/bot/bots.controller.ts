/**
 * Бот MAX: раздел администратора, кабинет клиента и приём событий от MAX
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 */

import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { parseId, permissionDenied } from '@zvonix/shared';
import { z } from 'zod';
import { Cabinets, Public, Roles } from '../../../http/auth.guard.js';
import { CurrentUser } from '../../../http/request-context.js';
import { zodBody } from '../../../http/zod.pipe.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { BotsService, type BotAdminView, type BotClientView } from './bots.service.js';

const registerBotSchema = z.object({ token: z.string().trim().min(1).max(500) });
const connectionSchema = z.object({ enabled: z.boolean() });

/** Событие платформы: берём нужное, остальное игнорируем (состав полей у MAX меняется). */
const idLike = z.union([z.string(), z.number()]).optional();
const attachmentSchema = z.looseObject({
  type: z.string().optional(),
  payload: z
    .looseObject({
      vcf_info: z.string().optional(),
      max_info: z.looseObject({ user_id: idLike }).optional(),
    })
    .optional(),
});
const botUpdateSchema = z.looseObject({
  update_type: z.string().optional(),
  chat_id: idLike,
  user: z.looseObject({ user_id: idLike }).optional(),
  payload: z.string().optional(),
  message: z
    .looseObject({
      sender: z.looseObject({ user_id: idLike }).optional(),
      recipient: z.looseObject({ chat_id: idLike }).optional(),
      body: z
        .looseObject({
          text: z.string().optional(),
          attachments: z.array(attachmentSchema).optional(),
        })
        .optional(),
      attachments: z.array(attachmentSchema).optional(),
    })
    .optional(),
});

/** Бот площадки у администратора: вписать токен, проверить, отключить. */
@Controller()
export class StaffBotController {
  constructor(private readonly bots: BotsService) {}

  @Roles('admin', 'support')
  @Get('bots/platform')
  state(): Promise<BotAdminView> {
    return this.bots.adminView();
  }

  @Roles('admin')
  @Put('bots/platform')
  register(
    @CurrentUser() actor: Principal,
    @Body(zodBody(registerBotSchema)) body: z.infer<typeof registerBotSchema>,
  ): Promise<BotAdminView> {
    return this.bots.registerPlatformBot(actor, body.token);
  }

  @Roles('admin')
  @Post('bots/platform/check')
  @HttpCode(200)
  check(@CurrentUser() actor: Principal): Promise<BotAdminView> {
    return this.bots.checkPlatformBot(actor);
  }

  @Roles('admin')
  @Post('bots/platform/disable')
  @HttpCode(200)
  disable(@CurrentUser() actor: Principal): Promise<BotAdminView> {
    return this.bots.disablePlatformBot(actor);
  }
}

/** Бот в кабинете клиента: подключиться, получить ссылку, включить и выключить. */
@Controller()
export class ClientBotController {
  constructor(
    private readonly bots: BotsService,
    private readonly billing: BillingService,
  ) {}

  @Cabinets('client')
  @Get('client/messages/bot')
  async get(@CurrentUser() actor: Principal): Promise<BotClientView> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return this.bots.clientView(client.id);
  }

  @Cabinets('client')
  @Post('client/messages/bot')
  async connect(@CurrentUser() actor: Principal): Promise<BotClientView> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return this.bots.connect(client.id);
  }

  @Cabinets('client')
  @Patch('client/messages/bot')
  async update(
    @CurrentUser() actor: Principal,
    @Body(zodBody(connectionSchema)) body: z.infer<typeof connectionSchema>,
  ): Promise<BotClientView> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return this.bots.setEnabled(client.id, body.enabled);
  }
}

/**
 * Приём событий бота от MAX. Открыт без входа, но защищён секретом бота в заголовке `X-Max-Bot-Api-Secret`
 * (его площадка сама передаёт MAX при подписке). Всегда `200` на событие, которое нас не касается: MAX повторяет
 * доставку при любом другом ответе и через 8 часов молчания сам отписывает бота.
 */
@Controller()
export class BotWebhookController {
  constructor(private readonly bots: BotsService) {}

  @Public()
  @Post('webhooks/max-bot/:botId')
  @HttpCode(200)
  async receive(
    @Param('botId') botId: string,
    @Headers('x-max-bot-api-secret') secret: string | undefined,
    @Body(zodBody(botUpdateSchema)) body: z.infer<typeof botUpdateSchema>,
  ): Promise<Record<string, never>> {
    const id = parseId(botId, 'messengerBot');
    // Чужому и несуществующему адресу — один и тот же отказ.
    if (!this.bots.secretMatches(id, secret)) throw permissionDenied('Недостаточно прав');
    await this.bots.handleUpdate(id, body);
    return {};
  }
}
