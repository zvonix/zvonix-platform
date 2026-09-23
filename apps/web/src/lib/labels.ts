import type {
  ApplicationStatus,
  Cabinet,
  CallFailureReason,
  CallStatus,
  ChannelStatus,
  ClientFailureReason,
  ClientStatus,
  GatewayPortState,
  GatewayStatus,
  GatewaySuspendedBy,
  GatewayType,
  LimitMetric,
  LimitWindow,
  NodeStatus,
  PartnerFacingSuspension,
  PartnerStatus,
  Rounding,
  SimStatus,
  TerminationKind,
  TransactionKind,
  UserRole,
  UserStatus,
} from '@zvonix/shared';

/**
 * Русские названия значений перечислений.
 *
 * Значения перечислений — часть машинного контракта и остаются латиницей
 * ([CLAUDE.md](../../../../CLAUDE.md), правило 10). Человеку они показываются
 * по-русски, и словарь здесь один на весь кабинет: `Record` по типу перечисления
 * не даст забыть новое значение — оно не соберётся.
 */
export const ROLE_NAME: Record<UserRole, string> = {
  admin: 'Администратор',
  support: 'Поддержка',
  partner: 'Партнёр',
  client: 'Клиент',
  member: 'Участник',
};

export const STATUS_NAME: Record<UserStatus, string> = {
  pending: 'Ждёт допуска',
  active: 'Работает',
  suspended: 'Приостановлена',
  disabled: 'Закрыта',
};

/**
 * Что означает состояние — для подтверждения опасного действия.
 *
 * [DESIGN.md](../../../../docs/DESIGN.md) требует подтверждения с указанием
 * последствий, а не «вы уверены?». Последствие здесь общее для всех состояний,
 * кроме `active`, и названо прямо: закрываются все действующие сессии
 * ([ADR-0018](../../../../docs/adr/0018-autentifikaciya.md)).
 */
export const STATUS_MEANING: Record<UserStatus, string> = {
  pending: 'Вход закрыт. Так заводится заявка на регистрацию до решения человека.',
  active: 'Вход открыт. Прежние сессии не восстанавливаются — нужен новый вход.',
  suspended: 'Вход закрыт временно, данные сохраняются. Все действующие сессии закрываются.',
  disabled: 'Вход закрыт окончательно. Все действующие сессии закрываются. Удаления нет.',
};

/** Цвет состояния: работает — зелёный, ждёт — жёлтый, закрыта — красный. */
export function statusTone(status: UserStatus): string {
  if (status === 'active') return 'bg-ok-soft text-ok';
  if (status === 'pending') return 'bg-warn-soft text-warn';
  return 'bg-crit-soft text-crit';
}

/** Состояние заявки на кабинет (ADR-0052). */
export const APPLICATION_STATUS_NAME: Record<ApplicationStatus, string> = {
  submitted: 'Ждёт решения',
  approved: 'Одобрена',
  rejected: 'Отказано',
  withdrawn: 'Отозвана',
};

export function applicationTone(status: ApplicationStatus): string {
  if (status === 'approved') return 'bg-ok-soft text-ok';
  if (status === 'submitted') return 'bg-warn-soft text-warn';
  if (status === 'rejected') return 'bg-crit-soft text-crit';
  return 'bg-muted text-muted-foreground';
}

/** Вид кабинета — так, как его называет человек. */
export const CABINET_KIND_NAME: Record<Cabinet, string> = {
  client: 'Служба такси',
  partner: 'Партнёр',
};

export const CLIENT_STATUS_NAME: Record<ClientStatus, string> = {
  pending: 'Ждёт допуска',
  active: 'Звонит',
  suspended: 'Приостановлен',
  closed: 'Закрыт',
};

/** Тот же приём, что и у учётных записей: работает — зелёный, ждёт — жёлтый, нет — красный. */
export function clientStatusTone(status: ClientStatus): string {
  if (status === 'active') return 'bg-ok-soft text-ok';
  if (status === 'pending') return 'bg-warn-soft text-warn';
  return 'bg-crit-soft text-crit';
}

/** Чей счёт показывает лента проводок. */
export type LedgerAccount = 'client' | 'partner';

/**
 * Виды операций в журнале проводок — **по стороне счёта**.
 *
 * Названия отвечают на вопрос «что это было», а не повторяют значение перечисления:
 * столбец сумм с подписью `charge` не объясняет ничего. И отвечают по-разному для разных
 * сторон: одна и та же операция `charge` у клиента — списание, у партнёра — начисление.
 * Общая подпись показывала партнёру «Списание за вызов» рядом с суммой в плюс
 * (ui-review, 2026-09-14).
 */
export const TRANSACTION_KIND_NAME: Record<LedgerAccount, Record<TransactionKind, string>> = {
  client: {
    deposit: 'Пополнение',
    charge: 'Списание за вызов',
    payout: 'Выплата',
    correction: 'Исправление',
  },
  partner: {
    deposit: 'Поступление',
    charge: 'Начисление за вызов',
    payout: 'Выплата',
    correction: 'Исправление',
  },
};

export const PARTNER_STATUS_NAME: Record<PartnerStatus, string> = {
  pending: 'Ждёт проверки',
  verified: 'Проверен',
  suspended: 'Приостановлен',
  closed: 'Закрыт',
};

/**
 * Что означает состояние партнёра — [DESIGN.md](../../../../docs/DESIGN.md) требует
 * подтверждения с названным последствием, а не «вы уверены?».
 *
 * Последствие здесь техническое и жёсткое: и регистрация шлюза, и отбор SIM под вызов
 * требуют `verified`, поэтому любое другое состояние означает «трафик не идёт».
 */
export const PARTNER_STATUS_MEANING: Record<PartnerStatus, string> = {
  pending:
    'Трафик не идёт: шлюз не зарегистрируется, SIM в отбор не попадут. Так партнёр заводится до проверки.',
  verified: 'Шлюз регистрируется, SIM участвуют в отборе, клиенты видят псевдоним в списке.',
  suspended: 'Трафик прекращается сразу. Данные и оборудование сохраняются, вернуть можно.',
  closed: 'Трафик прекращается. Состояние окончательное: вернуть партнёра в работу нельзя.',
};

/** Тот же приём, что и у клиентов: работает — зелёный, ждёт — жёлтый, нет — красный. */
export function partnerStatusTone(status: PartnerStatus): string {
  if (status === 'verified') return 'bg-ok-soft text-ok';
  if (status === 'pending') return 'bg-warn-soft text-warn';
  return 'bg-crit-soft text-crit';
}

export const GATEWAY_TYPE_NAME: Record<GatewayType, string> = {
  goip: 'GOIP',
  android: 'Android',
  sip_trunk: 'SIP-транк',
};

export const GATEWAY_STATUS_NAME: Record<GatewayStatus, string> = {
  pending: 'Ждёт',
  active: 'Работает',
  suspended: 'Приостановлен',
  retired: 'Выведен',
};

/**
 * Кто выключил шлюз — для администратора и поддержки
 * ([ADR-0047](../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
 *
 * От источника зависит, кто вправе вернуть: своё выключение партнёр снимает сам,
 * отключение администратором или порогом — нет. «Выключил порог» и «выключил
 * администратор» — разные разговоры с партнёром, поэтому показываются раздельно.
 */
export const GATEWAY_SUSPENDED_BY_NAME: Record<GatewaySuspendedBy, string> = {
  partner: 'выключил партнёр',
  admin: 'выключил администратор',
  failure_threshold: 'отключил порог отказов',
};

/** Кто выключил — так, как это видит партнёр: кто именно на площадке, не раскрывается. */
export const PARTNER_SUSPENSION_NAME: Record<PartnerFacingSuspension, string> = {
  partner: 'Выключен вами',
  platform: 'Отключён площадкой',
  failure_threshold: 'Отключён автоматически',
};

/** Последствие, когда администратор запирает шлюз, выключенный самим партнёром. */
export const GATEWAY_LOCK_MEANING =
  'Партнёр выключил шлюз сам и может включить его обратно. После приостановки площадкой включить или списать шлюз сможет только администратор.';

export const SIM_STATUS_NAME: Record<SimStatus, string> = {
  new: 'Новая',
  active: 'Работает',
  throttled: 'Придержана',
  blocked: 'Заблокирована',
  retired: 'Выведена',
};

/**
 * Годность объекта к работе — тем же цветом, что и состояние участника.
 *
 * Годными считаются ровно те состояния, которые пропускает маршрутизация
 * (`REGISTRABLE_GATEWAY_STATUSES`, `USABLE_SIM_STATUSES`): цвет обязан совпадать
 * с поведением, иначе он вводит в заблуждение вместо того, чтобы объяснять.
 */
export function usableTone(usable: boolean): string {
  return usable ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit';
}

/**
 * Правило округления денег в тарифе
 * ([ADR-0010](../../../../docs/adr/0010-model-billinga.md)).
 *
 * Округление происходит ровно один раз — при фиксации стоимости вызова, — и правило
 * это часть тарифа, а не кода. Значение `toward_zero` всегда в пользу клиента,
 * `half_away_from_zero` — обычное арифметическое.
 */
export const ROUNDING_NAME: Record<Rounding, string> = {
  half_away_from_zero: 'обычное',
  toward_zero: 'в пользу клиента',
};

/**
 * Состояние порта шлюза.
 *
 * `unknown` — не «неисправен», а «агент ещё не сказал»: автоматическое обнаружение
 * портов пока не сделано, и объявленный вручную порт остаётся в этом состоянии.
 * Маршрутизация его пропускает наравне с `idle` (`USABLE_PORT_STATES`) — иначе
 * ни один объявленный вручную порт не работал бы вовсе.
 */
export const PORT_STATE_NAME: Record<GatewayPortState, string> = {
  unknown: 'не опрошен',
  idle: 'свободен',
  busy: 'занят',
  fault: 'неисправен',
  disabled: 'выключен',
};

/**
 * Состояние канала клиента.
 *
 * Маршрутизация пропускает только `active`, и требует его **и от канала, и от самого
 * клиента**: закрытый клиент не звонит ни по одному каналу.
 */
export const CHANNEL_STATUS_NAME: Record<ChannelStatus, string> = {
  pending: 'Ждёт',
  active: 'Работает',
  suspended: 'Приостановлен',
};

/**
 * Что означает состояние шлюза — для подтверждения с названным последствием.
 *
 * Регистрацию на узле пропускает только `active`, поэтому любое другое состояние —
 * «вызовы через шлюз не идут». `retired` к тому же вынимает SIM из всех портов.
 */
export const GATEWAY_STATUS_MEANING: Record<GatewayStatus, string> = {
  pending:
    'Шлюз не регистрируется на узле, вызовы через него не идут. Так он заводится до допуска.',
  active: 'Шлюз регистрируется на узле, его SIM участвуют в отборе под вызовы.',
  suspended:
    'Следующая регистрация не пройдёт, новые вызовы через шлюз не идут. Идущие разговоры не рвутся. Включить обратно сможет только администратор: отключение площадкой партнёр не снимает.',
  retired:
    'Шлюз выводится навсегда, все SIM вынимаются из его портов. Вернуть его в работу нельзя — только завести новый.',
};

/**
 * Что означает состояние SIM — для подтверждения с названным последствием.
 *
 * В отбор под вызовы попадает только `active`. `blocked` сам не возвращается,
 * `retired` — навсегда.
 */
export const SIM_STATUS_MEANING: Record<SimStatus, string> = {
  new: 'SIM заведена, но в отбор под вызовы не попадает, пока её не включат.',
  active: 'SIM участвует в отборе под вызовы.',
  throttled:
    'SIM придержана: в отбор не попадает и сама не вернётся. Партнёр её не включает — только администратор.',
  blocked: 'SIM заблокирована: в отбор не попадает и сама не вернётся — только решением человека.',
  retired: 'SIM выводится навсегда. Вернуть её в работу нельзя.',
};

/**
 * Что означает состояние линии — для подтверждения с названным последствием.
 *
 * Звонит только `active`, и только если в `active` и сам клиент.
 */
export const CHANNEL_STATUS_MEANING: Record<ChannelStatus, string> = {
  pending: 'Линия не звонит. Так она заводится до допуска.',
  active: 'Линия звонит, если работает и сам клиент.',
  suspended: 'Звонки по линии прекращаются сразу. Настройки и история сохраняются, вернуть можно.',
};

/**
 * Что означает состояние клиента — для подтверждения с названным последствием.
 *
 * Последствие техническое и жёсткое: маршрутизация требует `active` и от канала,
 * и от клиента, поэтому любое другое состояние означает «ни один канал не звонит».
 */
export const CLIENT_STATUS_MEANING: Record<ClientStatus, string> = {
  pending: 'Ни один канал не звонит. Так клиент заводится до проверки.',
  active: 'Каналы в состоянии «работает» звонят. Деньги списываются по тарифу.',
  suspended: 'Звонки прекращаются сразу. Деньги, каналы и история сохраняются, вернуть можно.',
  closed: 'Звонки прекращаются. Состояние окончательное: вернуть клиента в работу нельзя.',
};

/**
 * Состояние вызова.
 *
 * Тарифицируется только `completed`: за неотвеченный вызов клиент не платит.
 */
export const CALL_STATUS_NAME: Record<CallStatus, string> = {
  routing: 'Ищется маршрут',
  ringing: 'Идёт вызов',
  answered: 'Разговор',
  completed: 'Состоялся',
  failed: 'Не состоялся',
  no_answer: 'Не ответили',
  busy: 'Занято',
  cancelled: 'Отменён',
};

/** Цвет состояния вызова: состоялся — зелёный, отказ платформы — красный. */
export function callTone(status: CallStatus): string {
  if (status === 'completed') return 'bg-ok-soft text-ok';
  if (status === 'failed') return 'bg-crit-soft text-crit';
  if (status === 'routing' || status === 'ringing' || status === 'answered') {
    return 'bg-warn-soft text-warn';
  }
  return 'bg-muted text-muted-foreground';
}

/**
 * Почему вызов не состоялся — вместе с тем, что с этим делать.
 *
 * Причина без указания на действие оставляет разбор на полпути: «нет тарифа»
 * не говорит, у кого именно и по какому направлению. Поэтому у каждой причины
 * названы **виновник** и **раздел, где это чинится**.
 */
export const FAILURE_REASON_NAME: Record<CallFailureReason, string> = {
  channel_unknown: 'Канал неизвестен или отключён',
  destination_invalid: 'Номер не разобран: короткий или служебный',
  operator_unconfirmed: 'Оператор номера не подтверждён',
  destination_blocked: 'Номер запрещён платформой',
  operator_not_allowed: 'Оператор не разрешён каналом',
  no_tariff: 'Нет цены или правила наценки',
  insufficient_funds: 'Не хватает денег',
  limit_exceeded: 'Исчерпан лимит',
  no_sim_available: 'Нет свободной SIM нужного оператора',
  gateway_unregistered: 'Шлюз не на связи с узлом',
  recording_required: 'Нужна запись, а подходят только шлюзы без неё',
  no_coverage: 'Регион номера никем не покрыт',
  node_lost: 'Узел не прислал CDR',
  internal_error: 'Внутренняя неисправность',
};

export const FAILURE_REASON_FIX: Record<CallFailureReason, string> = {
  channel_unknown:
    'Канал не найден, отключён либо клиент не в состоянии «звонит». Проверить оба состояния: маршрутизация требует «работает» и от канала, и от клиента.',
  destination_invalid:
    'Набранное не приводится к российскому номеру — короткий, экстренный или служебный. До определения оператора такой вызов не доходит: искать неисправность резолвера здесь нечего. В чёрный список такие номера не заводятся — его правила это префиксы одиннадцатизначных.',
  operator_unconfirmed:
    'Внешний источник не ответил. Звонить, не зная оператора, запрещено: неверная догадка — платный звонок с денег партнёра.',
  destination_blocked: 'Сработало правило из чёрного списка номеров. Запрет снимает администратор.',
  operator_not_allowed:
    'Настройка самого клиента: оператора нет в списке разрешённых для канала. Меняется в каналах клиента, а не платформой.',
  no_tariff:
    'У партнёра нет действующей цены по этому направлению либо нет правила наценки платформы. Раздел «Тарифы и наценка», цены партнёра — в его карточке.',
  insufficient_funds:
    'Остатка и разрешённого минуса не хватает даже на резерв под предельную длительность. Пополнить счёт или увеличить разрешённый минус.',
  limit_exceeded: 'Исчерпано окно лимита клиента или канала. Ждать конца окна либо поднять предел.',
  no_sim_available:
    'Годных SIM этого оператора нет: все заняты, отключены или порог неудач снял их с маршрутизации. Проверить SIM партнёров и качество терминации.',
  gateway_unregistered:
    'SIM подходящая есть, но её шлюз не зарегистрирован на узле, принявшем вызов: партнёр не включил оборудование, оно потеряло связь либо зарегистрировано на другом узле. Смотреть последний отклик шлюза в карточке партнёра.',
  recording_required:
    'Канал требует запись, а подошли только шлюзы вида «Android», где она технически невозможна. Либо снять требование, либо завести шлюз GOIP с покрытием.',
  no_coverage:
    'Ни один партнёр не объявил регион этого номера. Покрытие объявляется в карточке партнёра.',
  node_lost:
    'Вызов провисел открытым дольше предельной длительности: узел не прислал CDR. Это диагноз узла, а не платформы — рост числа таких вызовов означает, что с узлом что-то не так.',
  internal_error:
    'Неисправность control plane. Смотреть в журнал приложения по идентификатору вызова.',
};

/**
 * Состояние узла АТС.
 *
 * Маршрутизируются только `online` и `degraded`: молчание дольше полутора минут
 * снимает узел с маршрутизации независимо от того, что он присылал раньше.
 */
export const NODE_STATUS_NAME: Record<NodeStatus, string> = {
  provisioned: 'Заведён',
  installing: 'Ставится',
  online: 'Работает',
  degraded: 'Ослаблен',
  offline: 'Молчит',
  decommissioned: 'Выведен',
};

export const NODE_STATUS_MEANING: Record<NodeStatus, string> = {
  provisioned: 'Запись есть, машина ещё не отвечала. Вызовы не идут.',
  installing: 'Токен установки использован, агент ещё не прислал первый heartbeat.',
  online: 'Принимает вызовы.',
  degraded: 'Принимает вызовы, но сам объявил себя ослабленным: часть шлюзов не на связи.',
  offline: 'Молчит дольше полутора минут. Снят с маршрутизации автоматически.',
  decommissioned: 'Выведен из эксплуатации, ключи отозваны. Состояние окончательное.',
};

/** Цвет состояния узла: работает — зелёный, молчит или выведен — красный. */
export function nodeTone(status: NodeStatus): string {
  if (status === 'online') return 'bg-ok-soft text-ok';
  if (status === 'degraded' || status === 'installing' || status === 'provisioned') {
    return 'bg-warn-soft text-warn';
  }
  return 'bg-crit-soft text-crit';
}

/**
 * Окно лимита — **календарное и в UTC** ([ADR-0026](../../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Названо так, чтобы было видно, когда счётчик обнулится, а не «за последние сутки»:
 * окно фиксированное, а не скользящее.
 */
export const LIMIT_WINDOW_NAME: Record<LimitWindow, string> = {
  hour: 'в час',
  day: 'в сутки',
  week: 'в неделю',
  month: 'в месяц',
};

/**
 * Что считает лимит.
 *
 * Минуты хранятся секундами: разговор в 90 секунд — это не «полторы минуты»
 * и не «одна», а ровно девяносто.
 */
export const LIMIT_METRIC_NAME: Record<LimitMetric, string> = {
  calls: 'вызовов',
  minutes: 'секунд разговора',
};

/**
 * Причина отказа так, как её видит клиент.
 *
 * Набор уже внутреннего: часть причин говорит о нашей стороне, и по ним читалась бы
 * ёмкость площадки (`clientFailureReasonOf` в `@zvonix/shared`). Здесь тот же принцип
 * в словах: клиенту называется то, что он может исправить сам, и прямо говорится,
 * когда исправлять нечего.
 */
export const CLIENT_FAILURE_REASON_NAME: Record<ClientFailureReason, string> = {
  destination_blocked: 'Номер запрещён площадкой',
  destination_invalid: 'Короткий или служебный номер',
  operator_unconfirmed: 'Оператор номера не подтверждён',
  operator_not_allowed: 'Оператор не разрешён линией',
  insufficient_funds: 'Не хватает денег',
  limit_exceeded: 'Исчерпан лимит',
  platform: 'Отказ на нашей стороне',
};

export const CLIENT_FAILURE_REASON_FIX: Record<ClientFailureReason, string> = {
  destination_blocked:
    'Звонки на этот номер запрещены площадкой. Если запрет кажется ошибкой — напишите в поддержку.',
  destination_invalid:
    'Короткие, экстренные и служебные номера площадка не обслуживает: вызов уходит через SIM партнёра, и экстренная служба увидела бы не того, кто звонит. Звоните на такие номера с обычного телефона. Если номер обычный — проверьте набор, в нём должно быть одиннадцать цифр.',
  operator_unconfirmed:
    'Оператора номера не удалось подтвердить. Звонить, не зная оператора, площадка не станет: вызов ушёл бы за ваш счёт по чужому тарифу.',
  operator_not_allowed:
    'Оператор не входит в список, разрешённый для этой линии. Список меняется в настройках линии — это ваша настройка, не наша.',
  insufficient_funds:
    'Остатка и разрешённого минуса не хватило даже на резерв под вызов. Пополните счёт.',
  limit_exceeded: 'Исчерпано окно лимита. Счётчик обнулится в начале следующего окна.',
  platform:
    'Вызов не удалось выполнить на нашей стороне. Повторите позже; если повторяется — напишите в поддержку, назвав время и номер.',
};

/**
 * Способ терминации — через что вызов уходит с площадки
 * ([ADR-0040](../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
 *
 * Названо по пути вызова, а не по железу: клиенту незачем знать, GOIP у партнёра
 * или телефон, — это его оборудование. А «по воздуху или через интернет» знать нужно,
 * потому что от этого зависит цена.
 */
export const TERMINATION_KIND_NAME: Record<TerminationKind, string> = {
  sim: 'SIM',
  sip: 'SIP',
};

export const TERMINATION_KIND_MEANING: Record<TerminationKind, string> = {
  sim: 'по воздуху через сотовую сеть, SIM в шлюзе партнёра',
  sip: 'по интернету через транзитного оператора',
};
