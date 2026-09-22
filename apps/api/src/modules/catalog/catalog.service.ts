/**
 * Правила ведения справочника операторов.
 *
 * Справочник наполняет администратор: у оператора есть MNC, признак MVNO и хозяин
 * сети, а маршрутизация принимает эти значения за факт. Заводить оператора по одному
 * названию из внешнего ответа нельзя (ADR-0013).
 */

import { Injectable } from '@nestjs/common';
import { conflict, notFound, parseId, validationFailed } from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { CatalogRepository, type OperatorId, type OperatorRow } from './catalog.repository.js';
import { normalizeOperatorName } from './operator-name.js';
import type { CreateOperatorInput, VerifyOperatorInput } from './schemas.js';

export interface OperatorView {
  readonly id: string;
  readonly name: string;
  readonly inn: string | null;
  readonly mnc: string | null;
  readonly isMvno: boolean;
  readonly hostOperatorId: string | null;
  /**
   * Пусто — запись завёл импорт плана нумерации и человек её не смотрел
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   * По такому оператору вызов не совершается.
   */
  readonly verifiedAt: Date | null;
  readonly aliases: readonly string[];
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly audit: AuditService,
  ) {}

  async createOperator(
    input: CreateOperatorInput,
    actor: { userId: string; role: string },
  ): Promise<OperatorView> {
    const hostOperatorId =
      input.hostOperatorId == null ? null : parseId(input.hostOperatorId, 'operator');

    if (hostOperatorId !== null) {
      const host = await this.repository.findOperator(hostOperatorId);
      if (host === undefined) throw notFound('Оператор — хозяин сети не найден');
      if (host.isMvno) {
        // Иначе цепочка «MVNO на MVNO» уводит от физической сети, а именно она
        // и нужна маршрутизации.
        throw validationFailed('Хозяином сети не может быть виртуальный оператор');
      }
      if (host.verifiedAt === null) {
        // Единственное место, где отметка о проверке ещё что-то запрещает
        // (ADR-0035). Объявление MVNO — то самое утверждение, которое **расширяет**
        // множество допустимых SIM: прежде чем разрешить звонки на абонентов Йоты
        // через SIM МегаФона, кто-то должен посмотреть обе записи.
        throw validationFailed('Хозяин сети — неподтверждённая запись справочника');
      }
    }

    const created = await this.repository.createOperator({
      name: input.name,
      inn: input.inn,
      mnc: input.mnc,
      isMvno: input.isMvno,
      hostOperatorId,
      // Запись, заведённую человеком, подтверждать не у кого: он её и завёл,
      // назвав признак MVNO и хозяина сети (ADR-0032).
      verifiedAt: new Date(),
    });

    // Каноническое написание добавляется как синоним само: иначе оператор,
    // заведённый без синонимов, не найдётся по собственному же названию.
    const aliases = await this.addAliases(created.id, [input.name, ...input.aliases]);

    await this.audit.record({
      action: 'operator.created',
      entityType: 'operator',
      entityId: created.id,
      actorUserId: parseId(actor.userId, 'user'),
      after: { name: created.name, mnc: created.mnc, is_mvno: created.isMvno, aliases },
    });

    return { ...toView(created), aliases };
  }

  async addAlias(id: OperatorId, alias: string, actorUserId: string): Promise<OperatorView> {
    const operator = await this.repository.findOperator(id);
    if (operator === undefined) throw notFound('Оператор не найден');

    const normalized = normalizeOperatorName(alias);
    if (normalized === '') throw validationFailed('Написание пустое после приведения');

    const existing = await this.repository.findOperatorByName(alias);
    if (existing !== undefined) {
      // Одно написание не может указывать на двух операторов: иначе определение
      // становится неоднозначным ровно там, где ошибка стоит денег партнёра.
      throw conflict(
        existing.id === id
          ? 'Такое написание уже добавлено'
          : 'Такое написание уже закреплено за другим оператором',
      );
    }

    await this.repository.addAlias(id, alias);
    await this.audit.record({
      action: 'operator.alias_added',
      entityType: 'operator',
      entityId: id,
      actorUserId: parseId(actorUserId, 'user'),
      after: { alias: normalized },
    });

    return { ...toView(operator), aliases: await this.repository.listAliases(id) };
  }

  /**
   * Человек подтверждает запись, заведённую импортом
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * Подтверждение — это ответ на три вопроса разом: своя сеть или чужая, чья именно
   * и какой MNC. Отметить запись проверенной, не назвав их, значит ничего не проверить,
   * поэтому отдельной «кнопки подтвердить» без данных нет.
   */
  async verifyOperator(
    id: OperatorId,
    input: VerifyOperatorInput,
    actorUserId: string,
  ): Promise<OperatorView> {
    const operator = await this.repository.findOperator(id);
    if (operator === undefined) throw notFound('Оператор не найден');

    const hostOperatorId =
      input.hostOperatorId == null ? null : parseId(input.hostOperatorId, 'operator');

    if (hostOperatorId !== null) {
      const host = await this.repository.findOperator(hostOperatorId);
      if (host === undefined) throw notFound('Оператор — хозяин сети не найден');
      if (host.isMvno) {
        throw validationFailed('Хозяином сети не может быть виртуальный оператор');
      }
      if (host.verifiedAt === null) {
        // См. довод выше: объявление MVNO расширяет маршрутизацию (ADR-0035).
        throw validationFailed('Хозяин сети — неподтверждённая запись справочника');
      }
      if (host.id === id) throw validationFailed('Оператор не может быть хозяином сети сам себе');
    }

    const now = new Date();
    const updated = await this.repository.verifyOperator(
      id,
      { isMvno: input.isMvno, hostOperatorId, mnc: input.mnc },
      now,
    );
    if (updated === undefined) throw notFound('Оператор не найден');

    await this.audit.record({
      action: 'operator.verified',
      entityType: 'operator',
      entityId: id,
      actorUserId: parseId(actorUserId, 'user'),
      before: { is_mvno: operator.isMvno, host_operator_id: operator.hostOperatorId },
      after: {
        is_mvno: updated.isMvno,
        host_operator_id: updated.hostOperatorId,
        mnc: updated.mnc,
      },
    });

    return { ...toView(updated), aliases: await this.repository.listAliases(id) };
  }

  async listOperators(): Promise<OperatorView[]> {
    const [rows, aliases] = await Promise.all([
      this.repository.listOperators(),
      this.repository.listAliasesByOperators(),
    ]);
    return rows.map((row) => ({ ...toView(row), aliases: aliases.get(row.id) ?? [] }));
  }

  /** Подтверждённые операторы: имя и идентификатор, без синонимов и лишних полей. */
  async verifiedOperators(): Promise<{ id: string; name: string }[]> {
    return this.repository.listVerifiedOperators();
  }

  /**
   * Названия операторов по идентификаторам — для чужих модулей, где оператор
   * упомянут ссылкой (ARCHITECTURE.md, «Границы модулей»).
   */
  async operatorNamesOf(ids: readonly OperatorId[]): Promise<Map<string, string>> {
    return this.repository.operatorNamesOf(ids);
  }

  /** Добавляет написания, молча пропуская уже существующие: список приходит с повторами. */
  private async addAliases(id: OperatorId, names: readonly string[]): Promise<string[]> {
    const unique = [...new Set(names.map(normalizeOperatorName))].filter((alias) => alias !== '');
    for (const alias of unique) {
      const existing = await this.repository.findOperatorByName(alias);
      if (existing === undefined) await this.repository.addAlias(id, alias);
    }
    return this.repository.listAliases(id);
  }
}

function toView(row: OperatorRow): Omit<OperatorView, 'aliases'> {
  return {
    id: row.id,
    name: row.name,
    inn: row.inn,
    mnc: row.mnc,
    isMvno: row.isMvno,
    hostOperatorId: row.hostOperatorId,
    verifiedAt: row.verifiedAt,
  };
}
