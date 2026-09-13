/**
 * Загрузка плана нумерации
 * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
 *
 * Третья, самая слабая ступень определения оператора: план говорит, кому диапазон
 * **выделен**, а не кто обслуживает номер сейчас. Вызов по нему не совершается —
 * но без него номер, который не смог определить внешний сервис, не определяется вовсе.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { CatalogRepository, type NewPlanRange, type OperatorRow } from './catalog.repository.js';
import {
  NUMBERING_PLAN_FILE,
  parseNumberingPlan,
  type NumberingPlanFile,
  type PlanRange,
} from './numbering-plan.js';

/** Как часто перечитывается файл. Источник обновляет его не чаще раза в сутки. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Проверка правдоподобия набора перед заменой.
 *
 * Источник отдаёт страницу с ошибкой тем же кодом 200. Без этой проверки одна неудачная
 * загрузка стирает план нумерации целиком, а восстановится он только на следующие сутки.
 * Пороги взяты с большим запасом вниз: в файле 17 060 диапазонов и 83 DEF-кода.
 */
const MIN_RANGES = 10_000;
const MIN_DEF_CODES = 50;

/**
 * Доля неразобранных строк, после которой набор считается негодным.
 *
 * Одна-две строки — опечатка в источнике, и терять из-за них весь план глупо.
 * Каждая двадцатая — сменившийся формат, и принимать такой набор нельзя: он тихо
 * выкинет часть номерной ёмкости.
 */
const MAX_SKIPPED_SHARE = 0.05;

export interface PlanImportResult {
  readonly ranges: number;
  readonly skipped: number;
  readonly operatorsCreated: number;
}

@Injectable()
export class NumberingPlanService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: CatalogRepository,
    private readonly audit: AuditService,
    @Inject(NUMBERING_PLAN_FILE) private readonly file: NumberingPlanFile,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('numbering-plan');
  }

  /**
   * Обновляет план, если пора. Возвращает число загруженных диапазонов.
   *
   * Догоняющая по своей природе ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)):
   * решение принимается по отметке последней загрузки, а не по тому, случался ли проход.
   * Пропущенный тик ничего не теряет, два экземпляра воркера друг другу не мешают —
   * второй увидит свежую отметку и не станет качать.
   */
  async refresh(now: Date = new Date()): Promise<number> {
    if (!this.file.enabled) return 0;

    const last = await this.repository.lastPlanImportAt('mincifry');
    if (last !== undefined && now.getTime() - last.getTime() < REFRESH_INTERVAL_MS) return 0;

    const result = await this.load(now);
    return result?.ranges ?? 0;
  }

  /**
   * Скачивает, разбирает и заменяет план целиком.
   *
   * `undefined` — заменять было нечем: источник недоступен или отдал негодный набор.
   * Прежний план при этом остаётся на месте — устаревший план полезнее пустого.
   */
  async load(now: Date = new Date()): Promise<PlanImportResult | undefined> {
    const text = await this.file.download();
    if (text === undefined) return undefined;

    let parsed;
    try {
      parsed = parseNumberingPlan(text);
    } catch (cause) {
      // Разбор бросает только тогда, когда файл не похож на выгрузку вовсе. Молчать
      // здесь нельзя: без плана номера определяются хуже, и узнать об этом надо сразу.
      this.logger.error('План нумерации не разобран', cause);
      return undefined;
    }

    if (!this.plausible(parsed.ranges, parsed.skipped)) return undefined;

    const operators = await this.matchOperators(parsed.ranges);
    const ranges: NewPlanRange[] = parsed.ranges.map((range) => ({
      defCode: range.defCode,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      capacity: range.capacity,
      operatorId: operators.byKey.get(operatorKey(range))?.id ?? unreachable(range),
      region: range.region,
    }));

    const written = await this.repository.replaceNumberingPlan('mincifry', ranges, now);

    this.logger.info('План нумерации загружен', {
      ranges: written,
      skipped: parsed.skipped,
      operators: operators.byKey.size,
      operators_created: operators.created,
    });

    await this.audit.record({
      action: 'numbering_plan.imported',
      entityType: 'numbering_plan',
      entityId: 'mincifry',
      actorUserId: null,
      actorRole: null,
      after: {
        ranges: written,
        skipped: parsed.skipped,
        operators: operators.byKey.size,
        operators_created: operators.created,
      },
    });

    return { ranges: written, skipped: parsed.skipped, operatorsCreated: operators.created };
  }

  /**
   * Годится ли набор для замены.
   *
   * Проверяется до записи, а не после: замена целиком необратима, и «сначала стереть,
   * потом заметить» здесь означает сутки без плана нумерации.
   */
  private plausible(ranges: readonly PlanRange[], skipped: number): boolean {
    const defCodes = new Set(ranges.map((range) => range.defCode));

    if (ranges.length < MIN_RANGES || defCodes.size < MIN_DEF_CODES) {
      this.logger.error('Набор плана нумерации неправдоподобен: замена отменена', undefined, {
        ranges: ranges.length,
        def_codes: defCodes.size,
        min_ranges: MIN_RANGES,
        min_def_codes: MIN_DEF_CODES,
      });
      return false;
    }

    const total = ranges.length + skipped;
    if (skipped > total * MAX_SKIPPED_SHARE) {
      this.logger.error('Слишком много неразобранных строк: замена отменена', undefined, {
        skipped,
        total,
      });
      return false;
    }

    return true;
  }

  /**
   * Сопоставляет операторов файла со справочником, заводя недостающих непроверенными.
   *
   * Порядок поиска — ИНН, потом написание названия. ИНН первым, потому что одного
   * оператора файл называет по-разному, а ИНН у него один: сравнение по названию
   * завело бы трёх операторов вместо одного (ADR-0013).
   *
   * Найденному по названию ИНН не дописывается: запись, заведённая администратором,
   * — его зона ответственности, и молча править её из фоновой задачи неправильно.
   */
  private async matchOperators(
    ranges: readonly PlanRange[],
  ): Promise<{ byKey: Map<string, OperatorRow>; created: number }> {
    // Названия для каждого ключа: одному ИНН соответствует несколько написаний,
    // и все они должны попасть в синонимы, иначе внешний сервис не найдёт оператора.
    const names = new Map<string, Set<string>>();
    for (const range of ranges) {
      const key = operatorKey(range);
      const known = names.get(key);
      if (known === undefined) names.set(key, new Set([range.operatorName]));
      else known.add(range.operatorName);
    }

    const inns = [...names.keys()].filter((key) => key.startsWith(INN_PREFIX));
    const byInn = await this.repository.findOperatorsByInn(
      inns.map((key) => key.slice(INN_PREFIX.length)),
    );

    const byKey = new Map<string, OperatorRow>();
    let created = 0;

    for (const [key, spellings] of names) {
      const inn = key.startsWith(INN_PREFIX) ? key.slice(INN_PREFIX.length) : null;
      const first = [...spellings][0] ?? '';

      let operator = inn === null ? undefined : byInn.get(inn);
      operator ??= await this.repository.findOperatorByName(first);
      if (operator === undefined) {
        operator = await this.createImported({ name: first, inn });
        created += 1;
      }

      byKey.set(key, operator);
      for (const spelling of spellings) await this.repository.ensureAlias(operator.id, spelling);
    }

    return { byKey, created };
  }

  /**
   * Заводит оператора из файла.
   *
   * Столкновение по названию возможно: одно и то же название у двух юридических лиц
   * либо запись, заведённая администратором вручную под тем же именем. Это не ошибка
   * загрузки — берём существующего.
   */
  private async createImported(draft: { name: string; inn: string | null }): Promise<OperatorRow> {
    try {
      return await this.repository.createImportedOperator(draft);
    } catch (cause) {
      if (!(cause instanceof DomainError) || cause.code !== 'conflict') throw cause;

      const existing = await this.repository.findOperatorByName(draft.name);
      if (existing === undefined) throw cause;

      this.logger.warn('Название оператора уже занято: диапазоны отнесены к найденной записи', {
        name: draft.name,
        inn: draft.inn,
        operator_id: existing.id,
      });
      return existing;
    }
  }
}

/** Приставка ключа, чтобы ИНН и название не смешались в одном пространстве. */
const INN_PREFIX = 'inn:';

/** Ключ оператора в файле: ИНН, если он есть, иначе название. */
function operatorKey(range: PlanRange): string {
  return range.inn === null ? `name:${range.operatorName}` : `${INN_PREFIX}${range.inn}`;
}

/**
 * Оператор для каждого ключа заводится выше, поэтому сюда не попадают.
 *
 * Возвращать «какого-нибудь» оператора нельзя: диапазон, отнесённый не к тому
 * юридическому лицу, — это неверная цена и звонок не в ту сеть.
 */
function unreachable(range: PlanRange): never {
  throw new Error(`Оператор диапазона не сопоставлен: ${range.operatorName}`);
}
