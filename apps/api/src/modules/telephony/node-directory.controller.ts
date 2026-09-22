/**
 * Привязка `directory`: узел спрашивает учётную запись SIP (docs/api/node.md).
 *
 * Единственный обработчик проекта, который принимает `x-www-form-urlencoded` и отвечает
 * XML. Это не наш выбор: `mod_xml_curl` не умеет ни JSON, ни произвольных заголовков.
 *
 * **Код ответа всегда 200.** Любой другой `mod_xml_curl` отбрасывает целиком и пишет
 * ошибку в лог, а «записи нет» — штатный ответ, а не сбой: у него свой документ.
 */

import { Body, Controller, Get, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { directoryRequestSchema } from './schemas.js';
import { TelephonyService } from './telephony.service.js';

@Controller('node')
export class NodeDirectoryController {
  private readonly logger: Logger;

  constructor(
    private readonly telephony: TelephonyService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('node-directory');
  }

  /**
   * Разбор тела делается **внутри обработчика**, а не разборной трубой на входе.
   *
   * Причина не в удобстве. Труба бросает доменную ошибку, фильтр отдаёт её объектом JSON,
   * а заголовок обработчика уже объявлен как XML — Fastify отказывается отправлять объект
   * с таким типом и превращает ответ в 500. Для `mod_xml_curl` 500 означает «выбросить
   * ответ и записать ошибку в лог», то есть узел останется без учётных записей вообще.
   *
   * Поэтому здесь ошибок нет как класса: всё, чего не понимаем, — это «записи нет».
   */
  /**
   * Транки, которые этот узел обязан поднять у провайдеров
   * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
   *
   * Обратная сторона каталога: там перечислены те, кто регистрируется **к нам**, здесь —
   * те, к кому регистрируемся **мы**. Имя sofia-gateway совпадает с `sip_username`
   * шлюза, и по нему же диалплан направляет вызов.
   *
   * **Здесь пароль провайдера уходит в открытом виде** — иначе зарегистрироваться нельзя.
   * Обработчик доступен только узлу по его ключу, и ответ обязан идти по TLS
   * ([ADR-0019](../../../../../docs/adr/0019-dostup-mashin.md)). В ответы человеку
   * пароль не попадает никогда.
   *
   * Ответ JSON, а не XML: конфигурацию sofia собирает агент узла, а не `mod_xml_curl`.
   */
  @Machine('node')
  @Get('sip-gateways')
  async sipGateways(@CurrentMachine() machine: MachinePrincipal): Promise<{
    gateways: {
      name: string;
      proxy_host: string;
      register: boolean;
      username: string | null;
      password: string | null;
    }[];
  }> {
    const rows = await this.telephony.nodeTrunks(parseId(machine.ownerId, 'node'));
    return {
      gateways: rows.map((row) => ({
        name: row.name,
        proxy_host: row.proxyHost,
        register: row.registersOutbound,
        username: row.username,
        password: row.password,
      })),
    };
  }

  @Machine('node')
  @Post('directory')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  async directory(
    @Body() body: unknown,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<string> {
    const parsed = directoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Не 400: узел с неверной привязкой должен получить внятный «нет записи»,
      // а инженер — строку в логе. Молча этого оставлять нельзя, это ошибка настройки.
      this.logger.warn('Запрос каталога не разобран', {
        key_id: machine.keyId,
        problems: parsed.error.issues.map((issue) => issue.path.join('.') || '<корень>'),
      });
      return this.telephony.directoryNotFound();
    }

    // Имя учётной записи FreeSWITCH кладёт в `user`, а при части запросов — только
    // в `key_value`. Берём первое непустое, а не одно из двух: иначе часть регистраций
    // молча остаётся без ответа.
    const username = parsed.data.user ?? parsed.data.key_value;
    if (username === undefined || username === '') {
      return this.telephony.directoryNotFound();
    }

    return this.telephony.directory(username, parseId(machine.ownerId, 'node'));
  }
}
