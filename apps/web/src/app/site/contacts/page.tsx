import type { Metadata } from 'next';
import { CallToAction, PageHeader, Section } from '../blocks';
import { getSiteInfo, telHref, telegramHref } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Контакты',
  description: 'Как связаться: почта, телефон, Telegram, график работы.',
};

export default async function ContactsPage() {
  const info = await getSiteInfo();
  const rows: { label: string; value: string; href?: string }[] = [
    ...(info.companyName === '' ? [] : [{ label: 'Компания', value: info.companyName }]),
    ...(info.email === ''
      ? []
      : [{ label: 'Почта', value: info.email, href: `mailto:${info.email}` }]),
    ...(info.phone === ''
      ? []
      : [{ label: 'Телефон', value: info.phone, href: telHref(info.phone) }]),
    ...(info.telegram === ''
      ? []
      : [{ label: 'Telegram', value: info.telegram, href: telegramHref(info.telegram) }]),
    ...(info.workingHours === '' ? [] : [{ label: 'График', value: info.workingHours }]),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Контакты"
        title="Свяжитесь с нами"
        lead="Ответим на вопросы по подключению, ценам и интеграции."
      />
      <Section>
        {rows.length === 0 ? (
          <p className="max-w-xl rounded-lg border border-border bg-card p-5 text-muted-foreground">
            Контакты пока не опубликованы. Подайте заявку в кабинете — мы свяжемся с вами по
            указанным в ней данным.
          </p>
        ) : (
          <dl className="grid max-w-2xl gap-3">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-card p-4"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-medium">
                  {row.href === undefined ? (
                    row.value
                  ) : (
                    <a href={row.href} className="hover:text-primary hover:underline">
                      {row.value}
                    </a>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
