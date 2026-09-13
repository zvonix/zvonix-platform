import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import './globals.css';
import { Providers } from './providers';

/**
 * Шрифты забираются при сборке и раздаются со своего адреса.
 *
 * Не ссылкой на чужой сервер: панелью пользуются из корпоративной сети, и запрос
 * к постороннему хосту на каждой странице — и утечка адреса, и лишняя точка отказа.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Консоль Zvonix',
  description: 'Площадка терминации исходящих голосовых вызовов',
  // Панель не для поисковых машин, и содержимое её страниц — чужие персональные данные.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/*
         * Тема выставляется до первой отрисовки: React монтируется уже после того,
         * как браузер нарисовал первый кадр, и страница успевала бы мигнуть светлым
         * у того, кто выбрал тёмную. Отсюда же `suppressHydrationWarning` — атрибут
         * на `<html>` к моменту сверки уже стоит, и сервер о нём не знал.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-dvh font-sans text-base antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
