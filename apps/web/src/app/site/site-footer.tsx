import { NAV } from './nav';
import { telHref, telegramHref, type SiteInfo } from './site-data';

/** Подвал: разделы и контакты из настроек площадки. Пустое поле не показывается. */
export function SiteFooter({ info }: { info: SiteInfo }) {
  const hasContacts = info.email !== '' || info.phone !== '' || info.telegram !== '';
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-border bg-card">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 md:grid-cols-[1.2fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <a href="/" className="text-lg font-semibold tracking-tight">
            Zvonix
          </a>
          <p className="max-w-xs text-muted-foreground">
            Звонки и сообщения в одном месте: терминация через GSM-шлюзы партнёров и сообщения MAX.
          </p>
        </div>

        <nav aria-label="Разделы" className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Разделы
          </span>
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="hover:text-primary">
              {item.label}
            </a>
          ))}
          <a href="/contacts" className="hover:text-primary">
            Контакты
          </a>
        </nav>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Связь
          </span>
          {hasContacts ? (
            <>
              {info.email !== '' && (
                <a href={`mailto:${info.email}`} className="hover:text-primary">
                  {info.email}
                </a>
              )}
              {info.phone !== '' && (
                <a href={telHref(info.phone)} className="num hover:text-primary">
                  {info.phone}
                </a>
              )}
              {info.telegram !== '' && (
                <a href={telegramHref(info.telegram)} className="hover:text-primary">
                  {info.telegram}
                </a>
              )}
              {info.workingHours !== '' && (
                <span className="text-muted-foreground">{info.workingHours}</span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              Контакты появятся здесь после заполнения в настройках.
            </span>
          )}
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-muted-foreground">
          <span>
            © {String(year)} {info.companyName === '' ? 'Zvonix' : info.companyName}
          </span>
          {info.cabinetUrl !== '' && (
            <a href={`${info.cabinetUrl}/login`} className="hover:text-primary">
              Вход в кабинет
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
