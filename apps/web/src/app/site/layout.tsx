import type { Metadata } from 'next';
import './site.css';
import { getSiteInfo } from './site-data';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

// Страница строится на каждый запрос, а данные площадки (контакты, адрес кабинета, цены) берутся из кэша на минуту.
// Заранее собранная страница отдавала бы пустой адрес кабинета первые минуты после выкладки — пока API ещё не поднят:
// «Войти» вело бы в никуда (найдено 2026-10-16).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    default: 'Zvonix — звонки и сообщения в одном месте',
    template: '%s — Zvonix',
  },
  description:
    'Площадка для компаний и сервисов, которым нужно звонить и уведомлять клиентов, и для партнёров с GSM-оборудованием: звонки через GSM-шлюзы и сообщения в мессенджерах, прозрачные цены, лимиты и приоритеты.',
  // У кабинета индексация закрыта в корневом шаблоне; сайт, наоборот, должен находиться.
  robots: { index: true, follow: true },
};

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const info = await getSiteInfo();
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <SiteHeader cabinetUrl={info.cabinetUrl} />
      <main className="flex-1">{children}</main>
      <SiteFooter info={info} />
    </div>
  );
}
