/**
 * Проверка машинного ключа самой машиной (ADR-0019).
 *
 * То же, чем `/auth/me` служит человеку. Нужно скрипту установки и поддержке: ключ может
 * не приниматься из-за отзыва, срока или адреса, а снаружи все три отказа выглядят
 * одинаково — намеренно. Этот обработчик отвечает на единственный вопрос, который узел
 * может задать сам: «мой ключ сейчас принимается с этого адреса?»
 *
 * Секрет здесь не участвует ни в запросе сверх заголовка, ни в ответе.
 */

import { Controller, Get } from '@nestjs/common';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import type { MachinePrincipal } from './machine.service.js';

@Controller('machine')
export class MachineSelfController {
  /**
   * Пустой список видов означает «любой рабочий ключ». Токен установки сюда не попадает:
   * его отсекает сама проверка — рабочим ключом он не является.
   */
  @Machine()
  @Get('self')
  self(@CurrentMachine() machine: MachinePrincipal): {
    key_id: string;
    kind: string;
    owner_id: string | null;
  } {
    return { key_id: machine.keyId, kind: machine.kind, owner_id: machine.ownerId };
  }
}
