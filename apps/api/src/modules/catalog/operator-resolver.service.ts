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
import {
  isConfirmedSource,
  normalizeMsisdn,
  type Msisdn,
  type ResolutionSource,
} from '@zvonix/shared';
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
  /**
   * Названия операторов, которые вернул источник, но которых нет в справочнике.
   *
   * Возвращаются наружу, а не только пишутся в лог: это единственный способ узнать,
   * какие написания администратору нужно добавить. Без них пробел в справочнике
   * выглядит как «номер не определяется» и разбирается чтением логов.
   *
   * Сюда попадает и обслуживающий оператор, и прежний: незнакомый прежний оператор
   * означает, что факт переноса записан не будет, а это искажает и приоритет
   * фонового обновления, и замер доли перенесённых номеров.
   */
  readonly unknownOperatorNames?: readonly string[];
  /**
   * Источник сообщил, что номер переносился, — независимо от того, знает ли
   * справочник названного прежнего оператора.
   *
   * Отделено от `previousOperator` намеренно: иначе доля перенесённых номеров
   * занижается ровно на те случаи, где справочник неполон, то есть замер врёт
   * тем сильнее, чем хуже данные.
   */
  readonly portedBySource?: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Сколько номеров обновляется за один фоновый проход.
 *
 * Мало намеренно: темп обращений к источнику общий с горячим путём, и жадное
 * обновление отбирало бы его у настоящих вызовов.
 */
export const STALE_SWEEP_LIMIT = 20;

/**
 * С какого размера прохода полное молчание источника считается его недоступностью.
 *
 * На одном-двух номерах молчание — обычное дело: источник не знает всякий номер.
 * На пяти подряд — это уже он сам.
 */
const SILENT_SOURCE_THRESHOLD = 5;

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

      // Источник ответил, но названия нет в справочнике. Имя надо донести наверх:
      // иначе пробел в справочнике неотличим от неизвестного номера.
      return {
        ...(await this.fromNumberingPlan(msisdn, 'operator_not_in_catalog')),
        unknownOperatorNames: [answer.operatorName],
        portedBySource: answer.previousOperatorName !== undefined,
      };
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
    countUse = true,
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

    // Прежний оператор назван, но справочник его не знает: факт переноса записан
    // не будет. Это пробел справочника, и о нём нужно сообщить, а не проглотить.
    const missingPrevious =
      answer.previousOperatorName !== undefined && previous === undefined
        ? [answer.previousOperatorName]
        : [];

    await this.repository.saveResolution({
      msisdn,
      operatorId: serving.id,
      previousOperatorId: previousId,
      region: answer.region ?? null,
      source: 'lookup',
      resolvedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    });
    // Фоновое обновление обращением не считается: иначе счётчик востребованности,
    // по которому это же обновление и выбирает номера, растёт от собственной работы
    // и перестаёт что-либо значить.
    if (countUse) await this.repository.registerUse(msisdn, now);

    const resolution = await this.build(
      msisdn,
      serving.id,
      previousId,
      answer.region ?? null,
      'lookup',
    );
    return {
      ...resolution,
      portedBySource: answer.previousOperatorName !== undefined,
      ...(missingPrevious.length === 0 ? {} : { unknownOperatorNames: missingPrevious }),
    };
  }

  /**
   * Фоновое обновление просроченных записей
   * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)).
   *
   * Смысл в том, чтобы обращение к внешнему сервису не попадало в цепочку вызова.
   * Просроченная запись оператора не подтверждает, и вызов ждёт ответа источника —
   * это до восьмисот миллисекунд тишины в трубке. Обновлённая заранее запись отвечает
   * из своей базы мгновенно.
   *
   * Номера берутся **по востребованности**: сначала те, по которым звонят чаще.
   * Номера, по которым не звонят, не обновляются никогда и не стоят ничего.
   *
   * Проход намеренно маленький. Темп обращений к источнику общий с горячим путём
   * (два запроса в секунду на всю платформу), и жадное обновление отбирало бы его
   * у настоящих вызовов. Двадцать номеров за пять минут — это 0,07 запроса в секунду,
   * то есть ничего, и при этом четыре номера в минуту: базы в полтораста тысяч номеров
   * при сроке годности в месяц хватает с запасом.
   */
  async refreshStale(now: Date = new Date(), limit = STALE_SWEEP_LIMIT): Promise<number> {
    if (!this.lookup.enabled) return 0;

    const stale = await this.repository.findStaleResolutions(now, limit);
    if (stale.length === 0) return 0;

    let refreshed = 0;
    let answered = 0;

    for (const row of stale) {
      const msisdn = normalizeMsisdn(row.msisdn);
      // Номер в базе хранится в каноническом виде — сюда не попадает. Молча
      // пропустить всё же нельзя: это порча данных, а не редкий случай.
      if (msisdn === undefined) {
        this.logger.error('В базе разрешений номер не в каноническом виде', undefined, {
          resolution_id: row.id,
        });
        continue;
      }

      const answer = await this.lookup.lookup(msisdn);
      if (answer === undefined) continue;

      answered += 1;
      if ((await this.store(msisdn, answer, now, false)) !== undefined) refreshed += 1;
    }

    // Источник отвечал бы хоть на что-то: полное молчание на целом проходе означает,
    // что он недоступен или сменил формат ответа. Пока это единственный сигнал —
    // на пути вызова такие отказы теряются в общем шуме.
    if (answered === 0 && stale.length >= SILENT_SOURCE_THRESHOLD) {
      this.logger.error('Источник определения оператора не ответил ни на один номер', undefined, {
        asked: stale.length,
      });
    }

    return refreshed;
  }

  /**
   * Оператора номера подтвердил человек
   * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md)).
   *
   * Запись того же вида, что от внешнего источника, и с тем же сроком: когда источник
   * снова доступен, фоновое обновление перепишет её его ответом, как любую другую.
   * Возвращает прежнюю живую запись — для журнала, — и новую.
   */
  async confirmManually(
    msisdn: Msisdn,
    operatorId: OperatorRow['id'],
    now: Date = new Date(),
  ): Promise<{ previousOperatorId: OperatorRow['id'] | null; resolution: OperatorResolution }> {
    const previous = await this.repository.findLiveResolution(msisdn, now);
    const owner = await this.repository.findRangeOwner(msisdn);
    await this.repository.saveResolution({
      msisdn,
      operatorId,
      previousOperatorId: previous?.operatorId ?? null,
      region: previous?.region ?? owner?.region ?? null,
      source: 'manual',
      resolvedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    });
    this.logger.warn('Оператор номера подтверждён вручную', { msisdn: maskPhone(msisdn) });
    return {
      previousOperatorId: previous?.operatorId ?? null,
      resolution: await this.build(msisdn, operatorId, null, owner?.region ?? null, 'manual'),
    };
  }

  /**
   * Последний рубеж: кому выделен диапазон. Оператора не подтверждает.
   *
   * Открыт маршрутизации: когда источник не уложился в её бюджет, цена вызова берётся
   * по владельцу диапазона (ADR-0056) — это запрос к своей базе, без сети.
   */
  async fromNumberingPlan(msisdn: Msisdn, reason?: string): Promise<OperatorResolution> {
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
    // Виртуальным оператор становится **только по слову человека**
    // ([ADR-0035](../../../../../docs/adr/0035-operator-vladeet-svoey-setyu.md)):
    // это утверждение расширяет множество допустимых SIM, и ошибка в нём стоит денег
    // партнёра. Обратное — «своя сеть» — расширяет ничего и потому берётся по умолчанию,
    // в том числе у записей, заведённых импортом.
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
