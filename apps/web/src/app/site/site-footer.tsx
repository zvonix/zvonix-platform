import { CONTACTS, linkHref, NAV } from './nav';
import { telHref, telegramHref, type SiteInfo } from './site-data';

/** Подвал: те же группы, что в шапке, колонками, и «Связь» из настроек площадки. Пустое поле не показывается. */
export function SiteFooter({ info }: { info: SiteInfo }) {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-border bg-card">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-12 md:grid-cols-4 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
        <div className="col-span-2 flex flex-col gap-3 md:col-span-4 lg:col-span-1">
          <a href="/" className="text-lg font-semibold tracking-tight">
            Zvonix
          </a>
          <p className="max-w-xs text-muted-foreground">
            Звонки и сообщения в одном месте: терминация через GSM-шлюзы партнёров и сообщения в
            мессенджерах.
          </p>
        </div>

        {NAV.map((group) => (
          <nav key={group.title} aria-label={group.title} className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {group.title}
            </span>
            {group.items.map((item) => (
              <a
                key={item.href}
                href={linkHref(item, info.cabinetUrl)}
                className="hover:text-primary"
              >
                {item.label}
              </a>
            ))}
          </nav>
        ))}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Связь
          </span>
          {info.email !== '' && (
            <a href={`mailto:${info.email}`} className="break-all hover:text-primary">
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
          <a href={CONTACTS.href} className="hover:text-primary">
            {CONTACTS.label}
          </a>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-muted-foreground">
          <span>
            © {String(year)} {info.companyName === '' ? 'Zvonix' : info.companyName}
          </span>
          {info.cabinetUrl !== '' && (
            <a href={`${info.cabinetUrl}/login`} className="hover:text-primary">
              Войти
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
