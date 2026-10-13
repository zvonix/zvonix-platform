import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section, Steps } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Партнёрам',
  description:
    'Подключите GSM-шлюзы и SIM, задайте цену по операторам и получайте долю с каждого вызова.',
};

export default async function PartnersPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Партнёрам"
        title="Загрузите свои SIM и зарабатывайте на каждом вызове"
        lead="Вы подключаете GSM-шлюзы и SIM, задаёте свою цену, а площадка приводит клиентов и считает деньги по каждому разговору."
      />

      <Section title="Как подключиться">
        <Steps
          items={[
            {
              title: 'Подайте заявку',
              text: 'Партнёр проходит проверку администратором перед началом работы.',
            },
            {
              title: 'Подключите оборудование',
              text: 'Добавьте шлюз и SIM, вставьте карты в порты — оператор номера определяется сам.',
            },
            {
              title: 'Задайте цену',
              text: 'Тариф по операторам и регионам: ваша цена за минуту, шаг и плата за соединение.',
            },
          ]}
        />
      </Section>

      <Section title="Что даёт кабинет партнёра">
        <FeatureGrid>
          <Feature title="Своя цена по направлениям">
            Цена на все операторы и исключения по отдельным; у разных SIM могут быть разные тарифы.
          </Feature>
          <Feature title="Лимиты на карты" delay={60}>
            Ограничьте минуты и вызовы по SIM, тарифу или всему оборудованию, чтобы беречь карты.
          </Feature>
          <Feature title="Распределение вызовов" delay={120}>
            Поровну, по очереди, по весам; вес и приоритет задаются по каждой карте.
          </Feature>
          <Feature title="Выплаты и выписка">
            Сколько заработано, сколько выплачено и что причитается — по каждому вызову и за месяц.
          </Feature>
          <Feature title="Качество" delay={60}>
            Доля состоявшихся вызовов и причины отключений: SIM, которая стала плохо работать,
            снимается с маршрутизации.
          </Feature>
          <Feature title="Аккаунты MAX" delay={120}>
            Те же SIM могут отправлять сообщения MAX: вход по QR, цена и лимиты — в вашем кабинете.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section
        title="Клиенты вам не видны"
        lead="Вы видите свои вызовы и свои деньги, но не имена и цены клиентов."
      >
        <p className="max-w-2xl text-muted-foreground">
          Площадка распределяет трафик по цене, лимитам и приоритетам клиентов; вам остаётся
          поддерживать оборудование и цену.
        </p>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
