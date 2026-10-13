/**
 * Публичные данные для сайта проекта ([ADR-0082](../../../../../docs/adr/0082-sayt-proekta.md)).
 *
 * Без входа и только чтением: сайт стоит на открытом домене, и у посетителя нет сессии. Отдаётся
 * то, что владелец ввёл в разделе «Сайт» настроек площадки, и два адреса, выведенных из адреса
 * кабинета: куда вести кнопки «Войти» и «Подать заявку» и как называется сам сайт.
 */

import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public } from '../../http/auth.guard.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { SettingsService } from './settings.service.js';

interface SiteView {
  readonly company_name: string;
  readonly email: string;
  readonly phone: string;
  readonly telegram: string;
  readonly working_hours: string;
  /** Адрес кабинета: кнопки «Войти» и «Подать заявку» ведут сюда. */
  readonly cabinet_url: string;
  /** Адрес самого сайта, если кабинет стоит на `cp.<домен>`; иначе `null` — сайт отдельно не служит. */
  readonly site_url: string | null;
}

/** Основной домен для кабинета `https://cp.example.ru`: `https://example.ru`; иначе `null`. */
export function siteUrlOf(cabinetUrl: string): string | null {
  try {
    const url = new URL(cabinetUrl);
    if (url.protocol !== 'https:' || !url.hostname.startsWith('cp.')) return null;
    const root = url.hostname.slice(3);
    return root.includes('.') ? `https://${root}` : null;
  } catch {
    return null;
  }
}

@Controller()
export class PublicSiteController {
  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  /** Контакты и адреса. Кешируется на минуту: настройки читаются из кеша самой площадки. */
  @Public()
  @Get('public/site')
  @Header('Cache-Control', 'public, max-age=60')
  async site(): Promise<SiteView> {
    const site = await this.settings.site();
    const cabinetUrl = this.config.WEB_BASE_URL.replace(/\/+$/u, '');
    return {
      company_name: site.companyName,
      email: site.email,
      phone: site.phone,
      telegram: site.telegram,
      working_hours: site.workingHours,
      cabinet_url: cabinetUrl,
      site_url: siteUrlOf(cabinetUrl),
    };
  }
}
