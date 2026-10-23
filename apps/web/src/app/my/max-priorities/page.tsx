import { redirect } from 'next/navigation';

/** Прежний адрес очерёдности MAX: теперь она на странице «Маршруты» MAX — старые закладки не ломаются. */
export default function MyMaxPrioritiesPage(): never {
  redirect('/my/max-accounts');
}
