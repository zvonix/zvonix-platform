/**
 * Чёрный список номеров ([ADR-0024](../../../../../docs/adr/0024-chyornyy-spisok-nomerov.md)).
 *
 * Жёсткий запрет на уровне маршрутизации, до всякой тарификации. Ради чего он существует:
 * премиум-номера проходят нормализацию (`8-809-…` превращается в обычный `7809…`),
 * а звонки на дорогие направления — классическая схема кражи, по которой платит партнёр,
 * чья SIM совершила вызов.
 */

import { Injectable } from '@nestjs/common';
import { notFound, validationFailed, type Id, type Msisdn, type UserRole } from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { MAX_BLOCK_PREFIX_LENGTH, MIN_BLOCK_PREFIX_LENGTH } from './blocked-numbers.js';
import {
  BlockedNumberRepository,
  type BlockedNumberId,
  type BlockedNumberRow,
} from './blocked-numbers.repository.js';

@Injectable()
export class BlockedNumberService {
  constructor(
    private readonly repository: BlockedNumberRepository,
    private readonly audit: AuditService,
  ) {}

  /** Правило, запрещающее звонить на этот номер, если оно есть. */
  async findBlock(destination: Msisdn): Promise<BlockedNumberRow | undefined> {
    return this.repository.findMatching(destination);
  }

  async list(): Promise<BlockedNumberRow[]> {
    return this.repository.list();
  }

  async block(
    input: { prefix: string; note: string },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<BlockedNumberRow> {
    const prefix = normalizePrefix(input.prefix);
    const row = await this.repository.insert({ prefix, note: input.note.trim() });

    await this.audit.record({
      action: 'blocked_number.added',
      entityType: 'blocked_number',
      entityId: row.id,
      actorUserId,
      actorRole,
      after: { prefix: row.prefix, note: row.note },
    });
    return row;
  }

  /**
   * Снимает запрет.
   *
   * Удаление, а не отметка «снят»: чёрный список — это действующее правило, а не история.
   * След о том, кто и когда его снял, остаётся в журнале аудита — там же, где след
   * о том, кто его завёл.
   */
  async unblock(
    id: BlockedNumberId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<BlockedNumberRow> {
    const removed = await this.repository.remove(id);
    if (removed === undefined) throw notFound('Правило чёрного списка не найдено');

    await this.audit.record({
      action: 'blocked_number.removed',
      entityType: 'blocked_number',
      entityId: removed.id,
      actorUserId,
      actorRole,
      before: { prefix: removed.prefix, note: removed.note },
    });
    return removed;
  }
}

/**
 * Приводит префикс к каноническому виду: только цифры, ведущая `8` — это междугородный
 * префикс, а не часть номера.
 *
 * Правило вводит человек, и `8-809` он напишет так, как привык. Принять эту запись
 * буквально значило бы завести правило, которое не совпадёт ни с одним номером:
 * номера хранятся в виде `7809…`.
 */
function normalizePrefix(value: string): string {
  const digits = value.replace(/\D/g, '');
  const canonical = digits.startsWith('8') ? `7${digits.slice(1)}` : digits;

  if (!canonical.startsWith('7')) {
    throw validationFailed('Префикс начинается с семёрки или восьмёрки');
  }
  if (canonical.length < MIN_BLOCK_PREFIX_LENGTH) {
    // `7` — это вся страна, `79` — вся мобильная связь. Отказ в обслуживании из-за такой
    // опечатки выглядит для клиента точно так же, как авария платформы.
    throw validationFailed(
      `Префикс короче ${String(MIN_BLOCK_PREFIX_LENGTH)} цифр запретил бы всю страну`,
    );
  }
  if (canonical.length > MAX_BLOCK_PREFIX_LENGTH) {
    throw validationFailed('Префикс длиннее номера');
  }
  return canonical;
}
