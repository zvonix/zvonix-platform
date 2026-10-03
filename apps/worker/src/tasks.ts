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
  AlertsService,
  ServersService,
  ApplicationsService,
  CdrService,
  NumberingPlanService,
  EXPIRY_SWEEP_LIMIT,
  IdentityService,
  LimitService,
  LowBalanceService,
  MailService,
  NodesService,
  OperatorResolverService,
  QualityService,
  RecordingsService,
  ReservationService,
  RETENTION_SWEEP_LIMIT,
  SESSION_SWEEP_LIMIT,
  STALE_SWEEP_LIMIT,
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

/**
 * Как часто проверяются остатки клиентов для письма о низком балансе (ADR-0060).
 *
 * Пятнадцать минут: остаток тратится часами, а повтор письма ограничен тремя сутками,
 * так что чаще проверять нет смысла. Задача ничего не делает, пока настройка выключена.
 */
const LOW_BALANCE_SECONDS = 900;

/**
 * Как часто проверяются тревоги администраторам (ADR-0062).
 *
 * Пять минут: за столько узел, замолчавший ночью, уже виден, а повтор по одному объекту
 * ограничен полусутками, так что чаще проверять незачем. Задача ничего не делает,
 * пока настройка выключена.
 */
const ALERTS_SECONDS = 300;

/**
 * Как часто удаляются просроченные сессии.
 *
 * Срочности нет: работающему доступу просроченная сессия не мешает — `authenticate`
 * и так проверяет срок. Убирается она потому, что хранит адрес и клиента, то есть
 * данные о человеке, и держать их без причины не следует. Часа достаточно.
 */
const SESSION_SWEEP_SECONDS = 3600;

/**
 * Как часто убираются счётчики закрытых окон лимитов.
 *
 * Срочности нет вовсе: закрытое окно квоте не мешает — она смотрит только в текущее.
 * Это уборка строк, которые никто не читает, и раз в сутки её более чем достаточно.
 */
const LIMIT_COUNTER_SWEEP_SECONDS = 86_400;

/**
 * Как часто ищутся объекты, набравшие отказов сверх порога.
 *
 * Минута: каждый вызов на неисправную SIM — это несостоявшаяся поездка у клиента
 * и лишний повод оператору счесть профиль трафика машинным. Проход дешёвый —
 * агрегат по индексу, и только если порог вообще задан.
 */
const FAILURE_THRESHOLD_SWEEP_SECONDS = 60;

/**
 * Как часто уходят письма.
 *
 * Полминуты: человек, нажавший «восстановить пароль», смотрит в почту сразу, и минута
 * ожидания читается как «не работает». Проход дешёвый — выборка по индексу, и когда
 * писем нет, он ничего не делает.
 */
const MAIL_DELIVERY_SECONDS = 30;

/**
 * Как часто проверяется, не пора ли обновить план нумерации
 * ([ADR-0032](../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
 *
 * Раз в час, хотя файл обновляется раз в сутки: сама задача смотрит отметку последней
 * загрузки и почти всегда не делает ничего. Часовой шаг нужен не для свежести,
 * а для повтора — источник может не ответить, и ждать следующих суток из-за одной
 * неудачной попытки незачем.
 */
const NUMBERING_PLAN_SECONDS = 3600;

/**
 * Как часто обновляются просроченные записи об операторах номеров.
 *
 * Пять минут при двадцати номерах за проход — это четыре номера в минуту и 0,07
 * запроса в секунду к источнику. Темп обращений общий с горячим путём вызова,
 * и жадное обновление отбирало бы его у настоящих звонков; редкий же проход
 * не успевал бы за сроком годности.
 */
const RESOLUTION_REFRESH_SECONDS = 300;

/**
 * Как часто убираются отправленные письма и просроченные одноразовые токены.
 *
 * В теле письма лежит одноразовый токен: держать его дольше, чем нужно для разбора
 * «дошло ли», незачем. Срочности нет — раз в час.
 */
const MAIL_CLEANUP_SECONDS = 3600;

/**
 * Как часто площадка одобряет заявки партнёров сама, когда это включено
 * (`partners.auto_approve`). Раз в минуту: человек, подтвердивший почту, ждёт кабинет,
 * а выключенная настройка стоит одного чтения из кэша.
 */
const AUTO_APPROVE_SECONDS = 60;

/** Замер нагрузки площадки — раз в минуту, как и замеры узлов (ADR-0065). */
const SERVER_SAMPLE_SECONDS = 60;

@Injectable()
export class BackgroundTasks {
  constructor(
    private readonly reservations: ReservationService,
    private readonly cdr: CdrService,
    private readonly nodes: NodesService,
    private readonly recordings: RecordingsService,
    private readonly identity: IdentityService,
    private readonly limits: LimitService,
    private readonly quality: QualityService,
    private readonly mail: MailService,
    private readonly numberingPlan: NumberingPlanService,
    private readonly resolver: OperatorResolverService,
    private readonly applications: ApplicationsService,
    private readonly lowBalance: LowBalanceService,
    private readonly alerts: AlertsService,
    private readonly servers: ServersService,
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
      {
        name: 'sessions.purge-expired',
        everySeconds: SESSION_SWEEP_SECONDS,
        batchLimit: SESSION_SWEEP_LIMIT,
        run: (now) => this.identity.purgeExpiredSessions(now),
      },
      {
        name: 'limits.purge-closed-windows',
        everySeconds: LIMIT_COUNTER_SWEEP_SECONDS,
        run: (now) => this.limits.purgeClosedWindows(now),
      },
      {
        name: 'quality.suspend-over-threshold',
        everySeconds: FAILURE_THRESHOLD_SWEEP_SECONDS,
        run: (now) => this.quality.suspendOverThreshold(now),
      },
      {
        name: 'resolutions.refresh-stale',
        everySeconds: RESOLUTION_REFRESH_SECONDS,
        batchLimit: STALE_SWEEP_LIMIT,
        run: (now) => this.resolver.refreshStale(now),
      },
      {
        name: 'numbering-plan.refresh',
        everySeconds: NUMBERING_PLAN_SECONDS,
        run: (now) => this.numberingPlan.refresh(now),
      },
      {
        name: 'mail.deliver-due',
        everySeconds: MAIL_DELIVERY_SECONDS,
        run: (now) => this.mail.deliverDue(now),
      },
      {
        name: 'mail.purge-sent',
        everySeconds: MAIL_CLEANUP_SECONDS,
        run: (now) => this.mail.purgeSent(now),
      },
      {
        // Имя прежнее: переименование оставило бы в Redis расписание без обработчика.
        name: 'applications.auto-approve-partners',
        everySeconds: AUTO_APPROVE_SECONDS,
        run: () => this.applications.autoApprove(),
      },
      {
        name: 'notifications.low-balance',
        everySeconds: LOW_BALANCE_SECONDS,
        run: (now) => this.lowBalance.notify(now),
      },
      {
        name: 'notifications.alerts',
        everySeconds: ALERTS_SECONDS,
        run: (now) => this.alerts.notify(now),
      },
      {
        name: 'servers.sample',
        everySeconds: SERVER_SAMPLE_SECONDS,
        run: (now) => this.servers.samplePlatform(now),
      },
      {
        name: 'servers.purge-history',
        everySeconds: MAIL_CLEANUP_SECONDS,
        run: (now) => this.servers.purge(now),
      },
      {
        name: 'auth-tokens.purge-expired',
        everySeconds: MAIL_CLEANUP_SECONDS,
        batchLimit: SESSION_SWEEP_LIMIT,
        run: (now) => this.identity.purgeExpiredAuthTokens(now),
      },
    ];
  }
}
