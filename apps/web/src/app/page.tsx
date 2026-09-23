'use client';

import { isStaffRole, type StaffRole } from '@zvonix/shared';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { CABINET_HOME, homeCabinet, useCabinets } from '@/lib/cabinets';
import type { CurrentUser } from '@/lib/session';

/**
 * Корень кабинета: разводит вошедшего.
 *
 * Администратор и поддержка попадают в разбор вызовов: открывая кабинет, спрашивают
 * «что происходит», а не «какие тут настройки».
 *
 * Участник рынка — в свой кабинет: последний открытый, если он ещё есть, иначе первый
 * ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)). У клиента и партнёра
 * там их вызовы: первый вопрос у обоих тот же, только каждый со своей стороны.
 *
 * Перечисление, а не цепочка условий: новая роль сотрудника не соберётся, пока ей
 * не назначен раздел, — а роль без раздела открывала бы пустой экран.
 */
const STAFF_HOME: Record<StaffRole, string> = {
  admin: '/calls',
  support: '/calls',
};

export default function HomePage() {
  return <ConsoleShell title="Кабинет">{(user) => <Home user={user} />}</ConsoleShell>;
}

function Home({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const cabinets = useCabinets();
  const staff = isStaffRole(user.role);
  const cabinet = cabinets.data === undefined ? undefined : homeCabinet(cabinets.data);
  const target = isStaffRole(user.role)
    ? STAFF_HOME[user.role]
    : cabinet === undefined
      ? undefined
      : CABINET_HOME[cabinet];

  useEffect(() => {
    if (target !== undefined) router.replace(target);
  }, [target, router]);

  if (staff || target !== undefined) return null;
  if (cabinets.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {cabinets.error.message}
      </p>
    );
  }
  if (cabinets.isPending) return null;
  return (
    <p role="status">
      Кабинетов у вас пока нет: клиент или партнёр подключается заявкой, которую одобряет
      администратор площадки.
    </p>
  );
}
