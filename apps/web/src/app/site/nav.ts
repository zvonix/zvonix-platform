/**
 * Разделы сайта: шапка и подвал. Отдельный модуль — не из клиентского файла шапки, иначе список
 * в серверном подвале превращается в ссылку на клиентский компонент.
 *
 * Три группы с подменю и «Контакты» отдельной ссылкой. У всех групп подменю одинаковое — и у «Партнёрам»,
 * где страниц меньше: единообразие шапки важнее (владелец, 2026-11-16).
 */
export interface SiteLink {
  readonly href: string;
  readonly label: string;
  /** Адрес в кабинете, а не на сайте: к `href` спереди приписывается адрес кабинета. */
  readonly cabinet?: true;
}

export interface SiteGroup {
  readonly title: string;
  readonly items: readonly SiteLink[];
}

export const NAV: readonly SiteGroup[] = [
  {
    title: 'Клиентам',
    items: [
      { href: '/calls', label: 'Звонки' },
      { href: '/messages', label: 'Сообщения' },
      { href: '/pricing', label: 'Цены' },
      { href: '/integration', label: 'Подключение' },
    ],
  },
  {
    title: 'Партнёрам',
    items: [
      { href: '/partners', label: 'Как заработать' },
      { href: '/equipment', label: 'Подключение оборудования' },
      { href: '/payouts', label: 'Выплаты' },
      { href: '/register?cabinet=partner', label: 'Оставить заявку', cabinet: true },
    ],
  },
  {
    title: 'О сервисе',
    items: [
      { href: '/how-it-works', label: 'Как это работает' },
      { href: '/security', label: 'Безопасность и записи' },
      { href: '/faq', label: 'Вопросы и ответы' },
    ],
  },
];

export const CONTACTS: SiteLink = { href: '/contacts', label: 'Контакты' };

/** Куда ведёт ссылка: страница сайта — как есть, страница кабинета — по его адресу. */
export function linkHref(link: SiteLink, cabinetUrl: string): string {
  return link.cabinet === true ? `${cabinetUrl}${link.href}` : link.href;
}
