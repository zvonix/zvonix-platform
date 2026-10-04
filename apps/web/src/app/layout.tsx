import type { Metadata, Viewport } from 'next';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import './fonts.css';
import './globals.css';
import { Providers } from './providers';

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
    <html lang="ru" suppressHydrationWarning>
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
