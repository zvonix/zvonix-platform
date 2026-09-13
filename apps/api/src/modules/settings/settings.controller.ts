/**
 * HTTP-контракт настроек площадки
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 */

import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { MailService } from '../mail/mail.service.js';
import { changeSettingsSchema, testLetterSchema } from './schemas.js';
import { SettingsService, type SettingView } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Все настройки площадки.
   *
   * Только администратору: здесь адрес почтового сервера, имя для входа в него
   * и признак того, задан ли серверный ключ капчи. Сами секреты не отдаются никогда —
   * у них `value: null` и признак `is_set`.
   */
  @Roles('admin')
  @Get('settings')
  async list(): Promise<{ settings: SettingView[] }> {
    return { settings: await this.settings.list() };
  }

  /**
   * Меняет настройки — частичным объектом, только названные ключи.
   *
   * `PUT`, а не `PATCH`: значение настройки заменяется целиком, а не дополняется.
   * Неизвестный ключ — `404`, значение не того вида — `400`: список закрыт, и опечатка
   * в имени не должна тихо создавать настройку, которую никто не читает.
   */
  @Roles('admin')
  @Put('settings')
  async change(
    @Body(zodBody(changeSettingsSchema)) body: z.infer<typeof changeSettingsSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ settings: SettingView[] }> {
    return { settings: await this.settings.set(body.settings, actor.userId) };
  }

  /**
   * Пробное письмо.
   *
   * Единственный способ убедиться, что почта работает, не дожидаясь чужого
   * восстановления пароля. Идёт **мимо очереди** и отвечает результатом отправки:
   * очередь ответила бы «принято» и через полминуты положила бы ошибку в таблицу,
   * а смысл кнопки ровно в том, чтобы увидеть ответ почтового сервера сразу.
   */
  @Roles('admin')
  @HttpCode(200)
  @Post('settings/mail/test')
  async test(
    @Body(zodBody(testLetterSchema)) body: z.infer<typeof testLetterSchema>,
  ): Promise<{ delivered: boolean; error: string | null }> {
    return this.mail.sendTest(body.recipient);
  }
}
