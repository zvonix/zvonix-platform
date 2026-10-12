/** Разделы сайта: шапка и подвал. Отдельный модуль — не из клиентского файла шапки, иначе список
 * в серверном подвале превращается в ссылку на клиентский компонент. */
export const NAV: readonly { href: string; label: string }[] = [
  { href: '/clients', label: 'Клиентам' },
  { href: '/partners', label: 'Партнёрам' },
  { href: '/how-it-works', label: 'Как это работает' },
  { href: '/pricing', label: 'Цены' },
  { href: '/security', label: 'Безопасность' },
  { href: '/integration', label: 'Интеграция' },
  { href: '/faq', label: 'Вопросы' },
];
