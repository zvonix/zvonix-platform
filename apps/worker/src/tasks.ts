/**
 * Реестр фоновых задач (ADR-0020).
 *
 * Единственное место, где перечислено, что и как часто выполняется. Сама работа живёт
 * в доменных службах API — воркер её только вызывает по расписанию и никакой доменной
 * логики не содержит: своя копия тарификации или уборки в фоновом процессе разъедется
 * с основной на первой же правке.
 *
 * Требование к любой задаче в этом списке: **идемпотентность и догоняемость**. Задача
 * отбирает работу по сроку («резервы, истёкшие раньше `now`»), а не «сделанное с прошлого
 * запуска». Отсюда сразу три свойства: пропущенный тик ничего не теряет, два экземпляра
 * воркера не мешают друг другу, а недоступность Redis откладывает уборку, но не отменяет.
 */

import { Injectable } from '@nestjs/common';
import {
  CdrService,
  EXPIRY_SWEEP_LIMIT,
  NodesService,
  RecordingsService,
  ReservationService,
  RETENTION_SWEEP_LIMIT,
} from '@zvonix/api';
import { NODE_HEARTBEAT_INTERVAL_MS } from '@zvonix/shared';

export interface BackgroundTask {
  /**
   * Имя задачи. Оно же — ключ расписания в Redis.
   *
   * Переименование заводит новое расписание и оставляет старое сиротой, поэтому
   * при старте расписания сверяются с этим списком и лишние снимаются.
   */
  readonly name: string;
  /** Период между проходами. */
  readonly everySeconds: number;
  /**
   * Сколько сущностей задача берёт за один проход, если ограничение есть.
   *
   * Нужно не самой задаче, а наблюдению: проход, вернувший ровно предел, означает,
   * что работа поступает быстрее, чем убирается, и рано или поздно уборка отстанет
   * навсегда. Без этой проверки отставание не видно никак.
   */
  readonly batchLimit?: number;
  /** Возвращает, сколько сущностей обработано. */
  run(now: Date): Promise<number>;
}

/**
 * Как часто освобождаются просроченные резервы.
 *
 * Просроченный резерв — это замороженные деньги клиента по вызову, CDR по которому
 * потерялся. Срок резерва измеряется часами, так что минута задержки роли не играет;
 * проход дешёвый и берётся по индексу.
 */
const RESERVATION_SWEEP_SECONDS = 60;

/**
 * Как часто закрываются вызовы без CDR.
 *
 * Каждый такой вызов занимает место на SIM. Пока он висит, SIM не отдаётся под звонки —
 * то есть простаивает оборудование партнёра и не проходят заказы клиента.
 */
const ABANDONED_CALL_SWEEP_SECONDS = 60;

/**
 * Как часто снимаются замолчавшие узлы.
 *
 * Половина интервала heartbeat, а не произвольное число: пока узел числится живым,
 * маршрутизация направляет на него вызовы, которые некому обслужить. Каждый такой
 * вызов — несостоявшаяся поездка, поэтому задержка обнаружения здесь дороже,
 * чем лишний запрос к базе.
 */
const SILENT_NODE_SWEEP_SECONDS = Math.round(NODE_HEARTBEAT_INTERVAL_MS / 2 / 1000);

/**
 * Как часто удаляются записи с истёкшим сроком хранения.
 *
 * Срок измеряется сутками, но период задаёт не он, а пропускная способность: за проход
 * удаляется не больше `RETENTION_SWEEP_LIMIT` записей, и при часовом периоде потолок
 * составил бы менее пяти тысяч записей в сутки — площадка это перерастает. Пять минут
 * дают запас почти на шестьдесят тысяч.
 */
const RETENTION_SWEEP_SECONDS = 300;

@Injectable()
export class BackgroundTasks {
  constructor(
    private readonly reservations: ReservationService,
    private readonly cdr: CdrService,
    private readonly nodes: NodesService,
    private readonly recordings: RecordingsService,
  ) {}

  list(): readonly BackgroundTask[] {
    return [
      {
        name: 'reservations.release-expired',
        everySeconds: RESERVATION_SWEEP_SECONDS,
        batchLimit: EXPIRY_SWEEP_LIMIT,
        run: (now) => this.reservations.releaseExpired(now),
      },
      {
        name: 'calls.close-without-cdr',
        everySeconds: ABANDONED_CALL_SWEEP_SECONDS,
        run: (now) => this.cdr.closeCallsWithoutCdr(now),
      },
      {
        name: 'nodes.retire-silent',
        everySeconds: SILENT_NODE_SWEEP_SECONDS,
        run: async (now) => (await this.nodes.retireSilent(now)).length,
      },
      {
        name: 'recordings.remove-expired',
        everySeconds: RETENTION_SWEEP_SECONDS,
        batchLimit: RETENTION_SWEEP_LIMIT,
        run: (now) => this.recordings.removeExpired(now),
      },
    ];
  }
}
