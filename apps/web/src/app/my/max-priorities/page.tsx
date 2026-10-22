import { redirect } from 'next/navigation';

/** Прежний адрес очерёдности MAX: теперь это вкладка страницы «Маршруты» MAX — старые закладки не ломаются. */
export default function MyMaxPrioritiesPage(): never {
  redirect('/my/max-accounts?tab=order');
}
