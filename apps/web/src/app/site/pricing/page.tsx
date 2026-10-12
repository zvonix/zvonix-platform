import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section } from '../blocks';
import { getSiteInfo, getSitePrices, rubles } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Цены',
  description:
    'Цены от: звонок за минуту и сообщение MAX. Точная цена — в кабинете, по направлению.',
};

export default async function PricingPage() {
  const [info, prices] = await Promise.all([getSiteInfo(), getSitePrices()]);
  return (
    <>
      <PageHeader
        eyebrow="Цены"
        title="Платите за состоявшийся вызов и отправленное сообщение"
        lead="Цена складывается из тарифа партнёра и наценки площадки. Точные цифры по направлениям — у вас в кабинете до первого звонка."
      />

      <Section title="Цены от">
        <div className="grid gap-4 md:max-w-3xl md:grid-cols-2">
          <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-6">
            <h3 className="text-muted-foreground">Звонок</h3>
            <p className="text-3xl font-semibold tabular-nums">
              {prices.callFrom === null ? 'по запросу' : `от ${rubles(prices.callFrom)}`}
            </p>
            <p className="text-muted-foreground">
              {prices.callFrom === null
                ? 'Цену пришлём по заявке.'
                : 'за минуту разговора; посекундно или поминутно — по тарифу.'}
            </p>
          </article>
          <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-6">
            <h3 className="text-muted-foreground">Сообщение MAX</h3>
            <p className="text-3xl font-semibold tabular-nums">
              {prices.messageFrom === null ? 'по запросу' : `от ${rubles(prices.messageFrom)}`}
            </p>
            <p className="text-muted-foreground">
              {prices.messageFrom === null
                ? 'Цену пришлём по заявке.'
                : 'за одно отправленное сообщение.'}
            </p>
          </article>
        </div>
        <p className="mt-4 max-w-3xl text-muted-foreground">
          «От» — самая низкая цена среди доступных предложений на сейчас. Цена конкретного вызова
          зависит от оператора номера и тарифа партнёра.
        </p>
      </Section>

      <Section title="Из чего складывается цена">
        <FeatureGrid>
          <Feature title="Тариф партнёра">
            Цена за минуту, шаг тарификации и плата за соединение. Шаг — секунда или минута: на
            коротких вызовах это заметно.
          </Feature>
          <Feature title="Наценка площадки" delay={60}>
            Доля от стоимости плюс фиксированная часть, которую задаёт площадка; у отдельного
            клиента она может быть своей.
          </Feature>
          <Feature title="Без скрытых платежей" delay={120}>
            Состав цены виден в кабинете по каждому предложению; несостоявшийся вызов не стоит
            ничего.
          </Feature>
        </FeatureGrid>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} title="Узнайте свою цену" />
    </>
  );
}
