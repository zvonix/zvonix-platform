'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserRole } from '@zvonix/shared';
import {
  Coins,
  KeyRound,
  LogOut,
  PhoneCall,
  Radio,
  ReceiptText,
  Route,
  ScrollText,
  Server,
  Settings2,
  ShieldBan,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { useSession, type CurrentUser } from '@/lib/session';

/**
 * Кто видит версию выпуска. Номер подсказывает, какие известные уязвимости пробовать,
 * поэтому API отдаёт его только сотрудникам (`GET /health/version`).
 */
const SEES_RELEASE: readonly UserRole[] = ['admin', 'support'];

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

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly Icon: typeof Settings2;
}

interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

/**
 * Разделы по ролям — **только существующие**.
 *
 * Пункт, ведущий в ненаписанный раздел, хуже отсутствующего: он обещает, что там
 * что-то есть. Остальные разделы прототипа появятся здесь по мере готовности,
 * их список — в [ROADMAP.md](../../../../docs/ROADMAP.md), этап 5.
 */
const NAVIGATION: Record<UserRole, readonly NavGroup[]> = {
  admin: [
    {
      title: 'Участники',
      items: [{ href: '/users', label: 'Учётные записи', Icon: Users }],
    },
    {
      title: 'Терминация',
      items: [
        { href: '/partners', label: 'Партнёры и оборудование', Icon: Radio },
        { href: '/nodes', label: 'Узлы АТС', Icon: Server },
        { href: '/calls', label: 'Разбор вызовов', Icon: PhoneCall },
        { href: '/limits', label: 'Запреты и лимиты', Icon: ShieldBan },
      ],
    },
    {
      title: 'Деньги',
      items: [
        { href: '/clients', label: 'Клиенты и деньги', Icon: Wallet },
        { href: '/tariffs', label: 'Тарифы и наценка', Icon: Coins },
      ],
    },
    {
      title: 'Служебное',
      items: [
        { href: '/audit', label: 'Журнал действий', Icon: ScrollText },
        { href: '/settings', label: 'Настройки площадки', Icon: Settings2 },
      ],
    },
  ],
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
        { href: '/partner/calls', label: 'Вызовы через меня', Icon: PhoneCall },
        { href: '/partner/equipment', label: 'Моё оборудование', Icon: Radio },
        { href: '/partner/prices', label: 'Мои цены', Icon: ReceiptText },
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
        { href: '/my/calls', label: 'Вызовы', Icon: PhoneCall },
        { href: '/my/channels', label: 'Мои линии', Icon: Route },
        { href: '/my/prices', label: 'Мои цены', Icon: ReceiptText },
        { href: '/my/money', label: 'Деньги', Icon: Wallet },
        { href: '/my/integration', label: 'Интеграция', Icon: KeyRound },
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
      items: [{ href: '/users', label: 'Учётные записи', Icon: Users }],
    },
    {
      title: 'Терминация',
      items: [
        { href: '/partners', label: 'Партнёры и оборудование', Icon: Radio },
        { href: '/nodes', label: 'Узлы АТС', Icon: Server },
        { href: '/calls', label: 'Разбор вызовов', Icon: PhoneCall },
        { href: '/limits', label: 'Запреты и лимиты', Icon: ShieldBan },
      ],
    },
    {
      title: 'Деньги',
      items: [
        { href: '/clients', label: 'Клиенты и деньги', Icon: Wallet },
        { href: '/tariffs', label: 'Тарифы и наценка', Icon: Coins },
      ],
    },
    {
      title: 'Служебное',
      items: [{ href: '/audit', label: 'Журнал действий', Icon: ScrollText }],
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
}: {
  title: string;
  children: (user: CurrentUser) => React.ReactNode;
  requireRole?: UserRole | readonly UserRole[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const queryClient = useQueryClient();

  const denied = session.error instanceof ApiError && session.error.needsLogin;

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

  if (session.isPending || denied) {
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

  const groups = NAVIGATION[user.role];

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] md:grid-cols-[210px_1fr] md:grid-rows-1">
      <nav
        className="flex flex-col gap-4 bg-rail px-2 py-3 text-rail-ink md:min-h-dvh"
        aria-label="Разделы"
      >
        <div className="px-2 text-[15px] font-semibold tracking-tight text-white">Zvonix</div>

        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-[10px] font-semibold tracking-widest text-rail-ink-dim uppercase">
              {group.title}
            </div>
            {group.items.map((item) => {
              const current = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current ? 'page' : undefined}
                  className={
                    current
                      ? 'flex items-center gap-2 rounded-md bg-rail-active px-2 py-1.5 text-white'
                      : 'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-rail-active hover:text-white'
                  }
                >
                  <item.Icon size={14} strokeWidth={2} aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}

        <div className="mt-auto px-2 pt-2 text-[11px] text-rail-ink-dim">
          {user.fullName}
          <div className="truncate">{user.email}</div>
          {SEES_RELEASE.includes(user.role) ? <ReleaseVersion /> : null}
        </div>
      </nav>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitch />
            <button
              type="button"
              onClick={() => {
                logout.mutate();
              }}
              disabled={logout.isPending}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <LogOut size={13} strokeWidth={2} aria-hidden />
              Выйти
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4">
          {requireRole !== undefined && !allowed(requireRole).includes(user.role) ? (
            <p role="alert" className="text-crit">
              Раздел доступен {cabinetsOf(allowed(requireRole))}.
            </p>
          ) : (
            children(user)
          )}
        </main>
      </div>
    </div>
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
    <div className="grid min-h-dvh grid-rows-[auto_1fr] md:grid-cols-[210px_1fr] md:grid-rows-1">
      <div className="bg-rail px-2 py-3 md:min-h-dvh">
        <div className="px-2 text-[15px] font-semibold tracking-tight text-white">Zvonix</div>
      </div>
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center border-b border-border bg-card px-4 py-2.5">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        </header>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
