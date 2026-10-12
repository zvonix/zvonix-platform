/**
 * Публичные данные для сайта проекта ([ADR-0082](../../../../../docs/adr/0082-sayt-proekta.md)).
 *
 * Без входа и только чтением: сайт стоит на открытом домене, и у посетителя нет сессии. Отдаётся
 * ровно то, что владелец ввёл в разделе «Сайт» настроек площадки, — ничего вычисляемого из
 * закрытых данных.
 */

import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../../http/auth.guard.js';
import { SettingsService } from './settings.service.js';

interface SiteView {
  readonly company_name: string;
  readonly email: string;
  readonly phone: string;
  readonly telegram: string;
  readonly working_hours: string;
}

@Controller()
export class PublicSiteController {
  constructor(private readonly settings: SettingsService) {}

  /** Контакты и название компании. Кешируется на минуту: настройки читаются из кеша самой площадки. */
  @Public()
  @Get('public/site')
  @Header('Cache-Control', 'public, max-age=60')
  async site(): Promise<SiteView> {
    const site = await this.settings.site();
    return {
      company_name: site.companyName,
      email: site.email,
      phone: site.phone,
      telegram: site.telegram,
      working_hours: site.workingHours,
    };
  }
}
