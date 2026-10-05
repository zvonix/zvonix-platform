'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isStaffRole, type Cabinet, type StaffRole, type UserRole } from '@zvonix/shared';
import {
  Activity,
  Banknote,
  BarChart3,
  Coins,
  FileText,
  Gauge,
  HandCoins,
  HardDrive,
  Inbox,
  MessageSquare,
  KeyRound,
  Plus,
  LogOut,
  PhoneCall,
  Radio,
  ReceiptText,
  Route,
  ScrollText,
  Server,
  Settings2,
  ShieldBan,
  ShieldCheck,
  SignalHigh,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { MobileMenuButton, MobileTabs, SideNav, type NavGroup } from '@/components/shell-nav';
import { ThemeSwitch } from '@/components/theme-switch';
import { Button } from '@/components/ui/button';
import { useClientAccount, usePartnerAccount } from '@/lib/account';
import { ApiError, request } from '@/lib/api';
import {
  CABINET_HOME,
  cabinetOfPath,
  homeCabinet,
  rememberCabinet,
  useCabinets,
  type OwnedCabinets,
} from '@/lib/cabinets';
import { isNegative, money } from '@/lib/money';
import { useSession, type CurrentUser } from '@/lib/session';

/**
 * Кто видит версию выпуска. Номер подсказывает, какие известные уязвимости пробовать,
 * поэтому API отдаёт его только сотрудникам (`GET /health/version`).
 */
const SEES_RELEASE: readonly UserRole[] = ['admin', 'support'];

/** Как называется кабинет в переключателе и в отказе «раздел доступен из кабинета …». */
const CABINET_NAME: Record<Cabinet, string> = { client: 'Клиент', partner: 'Партнёр' };
const CABINET_GENITIVE: Record<Cabinet, string> = { client: 'клиента', partner: 'партнёра' };

interface ReleaseInfo {
  readonly version: string | null;
  readonly commit: string | null;
  readonly builtAt: string | null;
}

/** Какой выпуск работает: в углу панели, чтобы после выкладки было видно, что она доехала. */
function ReleaseVersion() {
  const release = useQuery({
    queryKey: ['release'],
    queryFn: () => request<ReleaseInfo>('/health/version'),
    // Выпуск меняется только выкладкой; пяти минут хватает, чтобы открытая вкладка
    // увидела новый без перезагрузки.
    staleTime: 5 * 60_000,
  });
  if (release.data === undefined) return null;
  const { version, commit, builtAt } = release.data;
  const details = [
    commit === null ? undefined : `коммит ${commit.slice(0, 7)}`,
    builtAt === null ? undefined : `собран ${new Date(builtAt).toLocaleString('ru-RU')}`,
  ].filter((part) => part !== undefined);
  return (
    <div className="num pt-1" title={details.length === 0 ? undefined : details.join(', ')}>
      {version === null ? 'сборка не из выпуска' : `версия ${version}`}
    </div>
  );
}

/**
 * Разделы сотрудников по ролям и разделы кабинетов участника — **только существующие**.
 *
 * Пункт, ведущий в ненаписанный раздел, хуже отсутствующего: он обещает, что там
 * что-то есть. Остальные разделы прототипа появятся здесь по мере готовности,
 * их список — в [ROADMAP.md](../../../../docs/ROADMAP.md), этап 5.
 */
const STAFF_NAVIGATION: Record<StaffRole, readonly NavGroup[]> = {
  admin: [
    {
      title: 'Участники',
      items: [
        { href: '/applications', label: 'Заявки', Icon: Inbox },
        { href: '/users', label: 'Учётные записи', Icon: Users },
      ],
    },
    {
      title: 'Терминация',
      items: [
        { href: '/partners', label: 'Партнёры и оборудование', Icon: Radio },
        { href: '/nodes', label: 'Узлы АТС', Icon: Server },
        { href: '/servers', label: 'Серверы', Icon: HardDrive },
        { href: '/operators', label: 'Операторы связи', Icon: SignalHigh },
        { href: '/calls', label: 'Разбор вызовов', Icon: PhoneCall },
        { href: '/quality', label: 'Качество', Icon: Activity },
        { href: '/messaging', label: 'Сообщения MAX', Icon: MessageSquare },
        { href: '/limits', label: 'Запреты и лимиты', Icon: ShieldBan },
      ],
    },
    {
      title: 'Деньги',
      items: [
        { href: '/reports', label: 'Сводка', Icon: BarChart3 },
        { href: '/clients', label: 'Клиенты и деньги', Icon: Wallet },
        { href: '/payments', label: 'Платежи', Icon: Banknote },
        { href: '/payouts', label: 'Выплаты партнёрам', Icon: HandCoins },
        { href: '/tariffs', label: 'Тарифы и наценка', Icon: Coins },
      ],
    },
    {
      title: 'Служебное',
      items: [
        { href: '/audit', label: 'Журнал действий', Icon: ScrollText },
        { href: '/settings', label: 'Настройки площадки', Icon: Settings2 },
        { href: '/security', label: 'Безопасность', Icon: ShieldCheck },
      ],
    },
  ],
  /**
   * Поддержка видит **только то, что читает**.
   *
   * Право на чтение у роли есть в API с самого появления обработчиков, а кабинета
   * не было вовсе: учётная запись поддержки заводилась и открывала пустой экран.
   * Разделы, написанные с оглядкой на роль (`useCanChange`), открыты ей полностью —
   * действия на них не показываются ([DESIGN.md](../../../../docs/DESIGN.md)):
   * нарисованная кнопка, отвечающая отказом, обещает возможность, которой нет.
   *
   * Настройки площадки закрыты и останутся закрытыми: там не «действия, недоступные
   * роли», а **секреты** — пароль почты и серверный ключ капчи. У них и обработчик
   * чтения помечен `@Roles('admin')`, так что раздел открывался бы пустым отказом.
   */
  support: [
    {
      title: 'Участники',
      items: [
        { href: '/applications', label: 'Заявки', Icon: Inbox },
        { href: '/users', label: 'Учётные записи', Icon: Users },
      ],
    },
    {
      title: 'Терминация',
      items: [
        { href: '/partners', label: 'Партнёры и оборудование', Icon: Radio },
        { href: '/nodes', label: 'Узлы АТС', Icon: Server },
        { href: '/servers', label: 'Серверы', Icon: HardDrive },
        { href: '/operators', label: 'Операторы связи', Icon: SignalHigh },
        { href: '/calls', label: 'Разбор вызовов', Icon: PhoneCall },
        { href: '/quality', label: 'Качество', Icon: Activity },
        { href: '/messaging', label: 'Сообщения MAX', Icon: MessageSquare },
        { href: '/limits', label: 'Запреты и лимиты', Icon: ShieldBan },
      ],
    },
    {
      title: 'Деньги',
      items: [
        { href: '/reports', label: 'Сводка', Icon: BarChart3 },
        { href: '/clients', label: 'Клиенты и деньги', Icon: Wallet },
        { href: '/payments', label: 'Платежи', Icon: Banknote },
        { href: '/payouts', label: 'Выплаты партнёрам', Icon: HandCoins },
        { href: '/tariffs', label: 'Тарифы и наценка', Icon: Coins },
      ],
    },
    {
      title: 'Служебное',
      items: [
        { href: '/audit', label: 'Журнал действий', Icon: ScrollText },
        { href: '/security', label: 'Безопасность', Icon: ShieldCheck },
      ],
    },
  ],
};

/**
 * Разделы кабинетов участника рынка
 * ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)): у одного человека
 * их может быть два, и меню берётся по кабинету страницы, а не по роли.
 */
const CABINET_NAVIGATION: Record<Cabinet, readonly NavGroup[]> = {
  /**
   * Кабинет партнёра.
   *
   * Партнёр распоряжается тем, что знает только он: своим оборудованием
   * ([ADR-0043](../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md))
   * и своей ценой — по направлению, где площадка открыла коридор. За площадкой
   * остаётся SIP-транк: он привязан к её узлу, и выбирать узел партнёру нечем.
   */
  partner: [
    {
      title: 'Мой кабинет',
      items: [
        { href: '/partner/reports', label: 'Сводка', Icon: BarChart3 },
        { href: '/partner/statement', label: 'Выписка за месяц', Icon: FileText },
        { href: '/partner/calls', label: 'Вызовы через меня', short: 'Вызовы', Icon: PhoneCall },
        {
          href: '/partner/equipment',
          label: 'Моё оборудование',
          short: 'Оборудование',
          Icon: Radio,
        },
        { href: '/partner/prices', label: 'Мои тарифы', short: 'Тарифы', Icon: ReceiptText },
        { href: '/partner/limits', label: 'Лимиты', Icon: Gauge },
        {
          href: '/partner/messages',
          label: 'Сообщения MAX',
          short: 'Сообщения',
          Icon: MessageSquare,
        },
        { href: '/partner/money', label: 'Деньги', Icon: Wallet },
      ],
    },
  ],
  /**
   * Кабинет клиента.
   *
   * Настраивать линию — порядок партнёров и разрешённых операторов — клиенту было
   * разрешено с самого начала, но перечислить свои линии он не мог ничем: право
   * существовало, а воспользоваться им было нечем.
   *
   * Заведение линий и пополнение счёта сюда не входят намеренно: и то и другое делает
   * площадка, и кнопка, которой у клиента нет права, обещала бы несуществующее.
   */
  client: [
    {
      title: 'Мой кабинет',
      items: [
        { href: '/my/reports', label: 'Сводка', Icon: BarChart3 },
        { href: '/my/act', label: 'Акт за месяц', Icon: FileText },
        { href: '/my/messages', label: 'Сообщения MAX', short: 'Сообщения', Icon: MessageSquare },
        { href: '/my/calls', label: 'Вызовы', Icon: PhoneCall },
        { href: '/my/channels', label: 'Мои линии', Icon: Route },
        { href: '/my/prices', label: 'Мои цены', Icon: ReceiptText },
        { href: '/my/money', label: 'Деньги', Icon: Wallet },
        { href: '/my/integration', label: 'Интеграция', Icon: KeyRound },
      ],
    },
  ],
};

/** Роли, которым открыт раздел: одна или несколько — вызывающему удобнее без обёртки. */
function allowed(requireRole: UserRole | readonly UserRole[]): readonly UserRole[] {
  return typeof requireRole === 'string' ? [requireRole] : requireRole;
}

/**
 * «только из кабинета администратора» либо «из кабинетов администратора и поддержки».
 *
 * Перечисление собирается, а не пишется строкой на каждый случай: раздел, открытый
 * двум ролям, — обычное дело, и «доступен только из кабинета администратора»
 * на экране поддержки было бы прямой неправдой.
 */
function cabinetsOf(roles: readonly UserRole[]): string {
  const names = roles.map((role) => ROLE_GENITIVE[role]);
  if (names.length === 1) return `только из кабинета ${names[0] ?? ''}`;
  return `из кабинетов ${names.slice(0, -1).join(', ')} и ${names.at(-1) ?? ''}`;
}

/** Как роль называется в родительном падеже: «кабинет партнёра», «кабинет поддержки». */
const ROLE_GENITIVE: Record<UserRole, string> = {
  admin: 'администратора',
  partner: 'партнёра',
  client: 'клиента',
  support: 'поддержки',
  member: 'участника',
};

/**
 * Каркас кабинета: тёмная колонка навигации, шапка, содержимое.
 *
 * Здесь же живёт единственная проверка входа на стороне браузера — и она нужна
 * только ради того, чтобы человек попал на страницу входа, а не на пустой экран.
 * Настоящий рубеж один, и он в API: каждая страница всё равно ходит за данными,
 * и без сессии не получит ничего ([ADR-0018](../../../../docs/adr/0018-autentifikaciya.md)).
 */
export function ConsoleShell({
  title,
  children,
  requireRole,
  cabinet,
}: {
  title: string;
  children: (user: CurrentUser) => React.ReactNode;
  /** Раздел сотрудников: открыт перечисленным ролям. */
  requireRole?: UserRole | readonly UserRole[];
  /** Раздел кабинета участника: открыт владельцу карточки этого вида (ADR-0052). */
  cabinet?: Cabinet;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const cabinets = useCabinets();
  const queryClient = useQueryClient();
  const pageCabinet = cabinet ?? cabinetOfPath(pathname);
  const ownsPageCabinet =
    pageCabinet !== undefined && cabinets.data !== undefined && cabinets.data[pageCabinet] !== null;

  useEffect(() => {
    if (ownsPageCabinet) rememberCabinet(pageCabinet);
  }, [ownsPageCabinet, pageCabinet]);

  const denied = session.error instanceof ApiError && session.error.needsLogin;
  // Администратору, обязанному подключить второй фактор, остальное закрыто (ADR-0067):
  // вместо стены отказов его ведут туда, где это делается.
  const mustSecure = session.data?.second_factor_required === true && pathname !== '/security';

  useEffect(() => {
    if (mustSecure) router.replace('/security');
  }, [mustSecure, router]);

  useEffect(() => {
    if (denied) router.replace('/login');
  }, [denied, router]);

  const logout = useMutation({
    mutationFn: () => request<undefined>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Кэш чистится и при неудаче выхода: остаться в кабинете с чужими данными
      // на экране хуже, чем лишний раз спросить пароль.
      queryClient.clear();
      router.replace('/login');
    },
  });

  const staff = session.data !== undefined && isStaffRole(session.data.role);
  if (session.isPending || denied || mustSecure || (!staff && cabinets.isPending)) {
    return <ShellSkeleton title={title} />;
  }

  // Страница заменяется ошибкой, только пока неизвестно, кто вошёл. Неудачное обновление
  // уже известной сессии экран не стирает: на нём бывает только что выданный пароль,
  // которого второй раз не покажут. Сессию, которой больше нет, ловит `denied` выше.
  const user = session.data;
  if (user === undefined) {
    return (
      <ShellSkeleton title={title}>
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-crit">{session.error.message}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={session.isFetching}
            onClick={() => {
              void session.refetch();
            }}
          >
            Повторить
          </Button>
        </div>
      </ShellSkeleton>
    );
  }

  const owned = cabinets.data;
  const current = isStaffRole(user.role)
    ? undefined
    : (pageCabinet ?? (owned === undefined ? undefined : homeCabinet(owned)));
  const cabinetGroups = current === undefined ? [] : CABINET_NAVIGATION[current];
  const groups = isStaffRole(user.role)
    ? STAFF_NAVIGATION[user.role]
    : [...cabinetGroups, ...secondCabinetGroup(owned)];

  const footer = (
    <>
      {user.full_name}
      <div className="truncate">{user.email}</div>
      {SEES_RELEASE.includes(user.role) ? <ReleaseVersion /> : null}
    </>
  );
  // У партнёра на телефоне — нижние вкладки: он работает с телефона в поле.
  const tabs = current === 'partner';

  return (
    <div className="flex min-h-dvh">
      <SideNav groups={groups} footer={footer} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Переносится, а не выдавливает: на телефоне переключатель кабинетов с темой
            и выходом в одну строку с заголовком не помещаются. */}
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-4 py-2.5 print:hidden">
          {!tabs && <MobileMenuButton groups={groups} footer={footer} />}
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {owned !== undefined && current !== undefined && owned[current] !== null ? (
              <BalanceChip cabinet={current} />
            ) : null}
            {owned !== undefined && current !== undefined ? (
              <CabinetSwitch owned={owned} current={current} />
            ) : null}
            <CommandPalette groups={groups} />
            <ThemeSwitch />
            <button
              type="button"
              onClick={() => {
                logout.mutate();
              }}
              disabled={logout.isPending}
              aria-label="Выйти"
              className="flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <LogOut size={13} strokeWidth={2} aria-hidden />
              <span className="hidden sm:inline">Выйти</span>
            </button>
          </div>
        </header>

        <main className={`min-w-0 flex-1 p-4 ${tabs ? 'pb-20 md:pb-4' : ''}`}>
          {requireRole !== undefined && !allowed(requireRole).includes(user.role) ? (
            <p role="alert" className="text-crit">
              Раздел доступен {cabinetsOf(allowed(requireRole))}.
            </p>
          ) : cabinet !== undefined && isStaffRole(user.role) ? (
            <p role="alert" className="text-crit">
              Раздел доступен только из кабинета {CABINET_GENITIVE[cabinet]}.
            </p>
          ) : cabinets.error !== null && cabinet !== undefined ? (
            <p role="alert" className="text-crit">
              {cabinets.error.message}
            </p>
          ) : cabinet !== undefined && owned?.[cabinet] === null ? (
            <p role="alert">
              Кабинет {CABINET_GENITIVE[cabinet]} у вас не подключён. Подключается заявкой, которую
              одобряет администратор площадки.
            </p>
          ) : (
            children(user)
          )}
        </main>
      </div>

      {tabs && <MobileTabs groups={groups} footer={footer} />}
    </div>
  );
}

/**
 * Путь ко второму кабинету: пока его нет, в меню — заявка на него, после одобрения —
 * переключатель в шапке. Без кабинетов вовсе — заявка на любой.
 */
function secondCabinetGroup(owned: OwnedCabinets | undefined): readonly NavGroup[] {
  if (owned === undefined) return [];
  if (owned.client !== null && owned.partner !== null) return [];
  // Без кабинетов вовсе «второй кабинет» — неправда: это первый, и путь к нему — заявка.
  if (owned.client === null && owned.partner === null) {
    return [
      {
        title: 'Подключение',
        items: [
          { href: '/', label: 'Моя заявка', Icon: Inbox },
          { href: '/apply', label: 'Подать заявку', Icon: Plus },
        ],
      },
    ];
  }
  // Площадка второй кабинет не подключает — и пункта в меню нет: он вёл бы в отказ.
  if (!owned.second_cabinet_open) return [];
  const missing =
    owned.client === null
      ? { href: '/apply?cabinet=client', label: 'Стать клиентом' }
      : { href: '/apply?cabinet=partner', label: 'Стать партнёром' };
  return [{ title: 'Второй кабинет', items: [{ ...missing, Icon: Plus }] }];
}

/**
 * Деньги на виду: у клиента — сколько ещё можно потратить, у партнёра — сколько к выплате.
 * Ссылка ведёт на «Деньги». Пока счёт не загрузился или не отвечает, шапка обходится без
 * плашки: неверное число на месте денег хуже пустого места.
 */
function BalanceChip({ cabinet }: { cabinet: Cabinet }) {
  const client = useClientAccount(cabinet === 'client');
  const partner = usePartnerAccount(cabinet === 'partner');
  const [title, value] =
    cabinet === 'client'
      ? ['Можно потратить', client.data?.funds.available]
      : ['К выплате', partner.data?.funds.balance];
  if (value === undefined) return null;
  return (
    <Link
      href={cabinet === 'client' ? '/my/money' : '/partner/money'}
      className="flex items-baseline gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-muted"
    >
      <span className="text-muted-foreground">{title}</span>
      <span className={`num font-semibold ${isNegative(value) ? 'text-crit' : ''}`}>
        {money(value)}
      </span>
    </Link>
  );
}

/**
 * Переключатель кабинетов в шапке — только когда их два (ADR-0052).
 *
 * Это ссылки, а не переключение состояния: кабинет определяется адресом страницы,
 * и другой кабинет — просто другая страница, которую можно открыть в соседней вкладке.
 */
function CabinetSwitch({ owned, current }: { owned: OwnedCabinets; current: Cabinet }) {
  if (owned.client === null || owned.partner === null) return null;
  return (
    <nav
      aria-label="Кабинет"
      className="flex gap-0.5 rounded-md border border-border bg-muted p-0.5"
    >
      {(['client', 'partner'] as const).map((kind) =>
        kind === current ? (
          <span
            key={kind}
            aria-current="page"
            className="rounded bg-card px-2.5 py-1 font-semibold shadow-[0_0_0_1px_var(--border)]"
          >
            {CABINET_NAME[kind]}
          </span>
        ) : (
          <Link
            key={kind}
            href={CABINET_HOME[kind]}
            className="rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
          >
            {CABINET_NAME[kind]}
          </Link>
        ),
      )}
    </nav>
  );
}

/**
 * Заглушка на время загрузки: та же сетка, та же высота шапки.
 *
 * Не спиннер во весь экран: содержимое не должно прыгать, когда данные приедут
 * ([DESIGN.md](../../../../docs/DESIGN.md)).
 */
function ShellSkeleton({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <div className="hidden w-[232px] bg-rail px-2 py-3 md:block">
        <div className="px-2 text-[15px] font-semibold tracking-tight text-white">Zvonix</div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center border-b border-border bg-card px-4 py-2.5">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        </header>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
