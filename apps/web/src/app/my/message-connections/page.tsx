import { redirect } from 'next/navigation';

/** Прежние «Подключения MAX» разделены на «Бот MAX» и «SMPP» (владелец, 2026-10-23) — старые закладки не ломаются. */
export default function MyMessageConnectionsPage(): never {
  redirect('/my/max-bot');
}
