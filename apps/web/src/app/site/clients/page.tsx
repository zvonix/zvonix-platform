import { permanentRedirect } from 'next/navigation';

/**
 * Прежняя страница «Клиентам» разделена на «Звонки» и «Сообщения» (меню сайта с подменю, 2026-11-16).
 * Адрес оставлен: на него могли сослаться, и он есть в поисковиках. Ведёт на «Звонки» — с них страница начиналась.
 */
export default function ClientsPage(): never {
  permanentRedirect('/calls');
}
