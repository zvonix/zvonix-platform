/**
 * Определение оператора номера (ADR-0013).
 *
 * Доменное правило, ради которого всё это существует: **вызов с неподтверждённым
 * оператором не совершается вовсе**. У всех партнёров тариф «безлимит внутри своей
 * сети», поэтому верное определение делает звонок бесплатным, а неверное — платным
 * для партнёра. Промежуточного варианта не существует, и гадать нельзя.
 *
 * Порядок разрешения:
 *   1. Собственная база — действующая запись, полученная ранее от внешнего сервиса.
 *   2. Внешний сервис — ответ сохраняется в собственную базу и дальше берётся оттуда.
 *   3. План нумерации — кому диапазон **выделен**. Оператора не подтверждает:
 *      для перенесённого номера это неверный ответ.
 */

import { Inject, Injectable } from '@nestjs/common';
import { maskPhone } from '@zvonix/logger';
import { isConfirmedSource, type Msisdn, type ResolutionSource } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { CatalogRepository, type OperatorRow } from './catalog.repository.js';
import { OPERATOR_LOOKUP, type LookupAnswer, type OperatorLookup } from './operator-lookup.js';

/**
 * Ответ резолвера: три разных оператора, а не один.
 *
 * Различие принципиально и выяснено на реальном номере. Диапазон `913 03…04` выделен
 * МТС, обслуживается СберМобайлом (это MVNO), а физически работает в чужой сети.
 * Для маршрутизации важна физическая сеть, но считать ли звонок на абонента MVNO
 * внутрисетевым — вопрос условий тарифа партнёра, а не техники.
 */
export interface OperatorResolution {
  readonly msisdn: Msisdn;
  /** Кому выделен диапазон, по плану нумерации. */
  readonly rangeOwner: OperatorRow | undefined;
  /** Кто обслуживает абонента сейчас. */
  readonly serving: OperatorRow | undefined;
  /** Физическая сеть: у виртуального оператора — хозяин сети, иначе он сам. */
  readonly network: OperatorRow | undefined;
  /** Прежний оператор, если номер переносился. */
  readonly previousOperator: OperatorRow | undefined;
  readonly region: string | undefined;
  /** Чем определён оператор. Записывается в CDR: без этого спор о цене не разобрать. */
  readonly source: ResolutionSource | undefined;
  /**
   * Можно ли на основании этого ответа совершать вызов.
   *
   * `false` означает отказ в вызове, а не выбор запасного варианта: SIM
   * с внесетевыми минутами в модели не существует.
   */
  readonly confirmed: boolean;
  /** Почему не подтверждён — для внятного отказа и для разбора. */
  readonly reason?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class OperatorResolverService {
  private readonly ttlMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly repository: CatalogRepository,
    @Inject(OPERATOR_LOOKUP) private readonly lookup: OperatorLookup,
    @Inject(APP_CONFIG) config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.ttlMs = config.NUMBER_RESOLUTION_TTL_DAYS * MS_PER_DAY;
    this.logger = logger.child('operator-resolver');
  }

  async resolve(msisdn: Msisdn, now: Date = new Date()): Promise<OperatorResolution> {
    const stored = await this.repository.findLiveResolution(msisdn, now);
    if (stored !== undefined) {
      // Отметка обращения нужна фоновому обновлению: оно ходит по востребованным
      // номерам, а не по всем подряд.
      await this.repository.registerUse(msisdn, now);
      return this.build(
        msisdn,
        stored.operatorId,
        stored.previousOperatorId,
        stored.region,
        stored.source,
      );
    }

    const answer = await this.lookup.lookup(msisdn);
    if (answer !== undefined) {
      const resolved = await this.store(msisdn, answer, now);
      if (resolved !== undefined) return resolved;
    }

    return this.fromNumberingPlan(msisdn, this.lookup.enabled ? undefined : 'lookup_disabled');
  }

  /**
   * Сохраняет ответ внешнего сервиса в собственную базу.
   *
   * Возвращает `undefined`, если оператор из ответа не найден в справочнике.
   * Заводить оператора автоматически нельзя: у записи есть MNC, признак MVNO
   * и хозяин сети, а созданная по одному названию запись имела бы пустые значения,
   * которые маршрутизация приняла бы за факт. Такой случай — сигнал администратору
   * добавить написание в справочник, а не повод угадывать.
   */
  private async store(
    msisdn: Msisdn,
    answer: LookupAnswer,
    now: Date,
  ): Promise<OperatorResolution | undefined> {
    const serving = await this.repository.findOperatorByName(answer.operatorName);
    if (serving === undefined) {
      this.logger.error('Оператор из ответа источника не найден в справочнике', undefined, {
        operator_name: answer.operatorName,
        msisdn: maskPhone(msisdn),
      });
      return undefined;
    }

    const previous =
      answer.previousOperatorName === undefined
        ? undefined
        : await this.repository.findOperatorByName(answer.previousOperatorName);

    // Прежний оператор, совпавший с текущим, — признак ошибки разбора ответа.
    // База такую пару отвергнет ограничением, поэтому отбрасываем здесь.
    const previousId = previous === undefined || previous.id === serving.id ? null : previous.id;

    await this.repository.saveResolution({
      msisdn,
      operatorId: serving.id,
      previousOperatorId: previousId,
      region: answer.region ?? null,
      source: 'lookup',
      resolvedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    });
    await this.repository.registerUse(msisdn, now);

    return this.build(msisdn, serving.id, previousId, answer.region ?? null, 'lookup');
  }

  /** Последний рубеж: кому выделен диапазон. Оператора не подтверждает. */
  private async fromNumberingPlan(msisdn: Msisdn, reason?: string): Promise<OperatorResolution> {
    const owner = await this.repository.findRangeOwner(msisdn);

    if (owner === undefined) {
      return {
        msisdn,
        rangeOwner: undefined,
        serving: undefined,
        network: undefined,
        previousOperator: undefined,
        region: undefined,
        source: undefined,
        confirmed: false,
        reason: reason ?? 'unknown_number',
      };
    }

    return {
      msisdn,
      rangeOwner: owner.operator,
      serving: undefined,
      network: undefined,
      previousOperator: undefined,
      region: owner.region ?? undefined,
      source: 'numbering_plan',
      confirmed: false,
      reason: reason ?? 'range_owner_only',
    };
  }

  /** Собирает полный ответ по идентификаторам: владелец диапазона, обслуживающий, сеть. */
  private async build(
    msisdn: Msisdn,
    servingId: OperatorRow['id'],
    previousId: OperatorRow['id'] | null,
    region: string | null,
    source: ResolutionSource,
  ): Promise<OperatorResolution> {
    const serving = await this.repository.findOperator(servingId);
    if (serving === undefined) {
      // Внешний ключ этого не допускает; если случилось — данные повреждены,
      // и молча выдавать «оператор не найден» нельзя.
      this.logger.error('Запись ссылается на несуществующего оператора', undefined, {
        msisdn: maskPhone(msisdn),
      });
      return this.fromNumberingPlan(msisdn, 'broken_reference');
    }

    // У виртуального оператора своей сети нет: физическая сеть — сеть хозяина.
    const network = serving.isMvno
      ? serving.hostOperatorId === null
        ? undefined
        : await this.repository.findOperator(serving.hostOperatorId)
      : serving;

    const previous =
      previousId === null ? undefined : await this.repository.findOperator(previousId);
    const owner = await this.repository.findRangeOwner(msisdn);

    return {
      msisdn,
      rangeOwner: owner?.operator,
      serving,
      network,
      previousOperator: previous,
      region: region ?? owner?.region ?? undefined,
      source,
      confirmed: isConfirmedSource(source),
    };
  }

  /**
   * Обращение партнёра «вызов ушёл не в мою сеть».
   *
   * Отменяет запись немедленно и не требует измерять чужую экономику: партнёр видит
   * счёт от своего оператора сам, а нам нужен только факт «этот номер определён неверно».
   */
  async invalidate(msisdn: Msisdn, now: Date = new Date()): Promise<boolean> {
    const invalidated = await this.repository.invalidateResolution(msisdn, now);
    if (invalidated) {
      this.logger.warn('Запись об операторе отменена по обращению партнёра', {
        msisdn: maskPhone(msisdn),
      });
    }
    return invalidated;
  }
}
