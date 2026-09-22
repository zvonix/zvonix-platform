'use client';

import type { UserRole } from '@zvonix/shared';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ConsoleShell } from '@/components/console-shell';

/**
 * Корень кабинета: разводит вошедшего по его роли.
 *
 * Администратор и поддержка попадают в разбор вызовов: открывая кабинет, спрашивают
 * «что происходит», а не «какие тут настройки». Раньше корень вёл в настройки площадки —
 * потому что это был единственный написанный раздел, а не потому, что он главный.
 * Клиент и партнёр попадают в свои вызовы: у обоих тот же первый вопрос, только каждый
 * со своей стороны.
 *
 * Перечисление, а не цепочка условий: новая роль не соберётся, пока ей не назначен
 * раздел, — а роль без раздела открывала бы пустой экран.
 */
const HOME: Record<UserRole, string> = {
  admin: '/calls',
  support: '/calls',
  client: '/my/calls',
  partner: '/partner/calls',
};

export default function HomePage() {
  const router = useRouter();

  return (
    <ConsoleShell title="Кабинет">
      {(user) => <RedirectTo href={HOME[user.role]} router={router} />}
    </ConsoleShell>
  );
}

function RedirectTo({ href, router }: { href: string; router: ReturnType<typeof useRouter> }) {
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return null;
}
