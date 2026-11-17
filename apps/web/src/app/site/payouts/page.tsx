import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

/**
 * Только то, что есть в коде: доля по тарифу партнёра, выписка, «Деньги», выплата, которую площадка переводит
 * и записывает. Расписания, минимальной суммы и заявки на выплату нет — и на странице их нет; модель выплат
 * (самозанятые, договор) — открытый вопрос владельца (DOMAIN.md, «Открытые вопросы»).
 */
export const metadata: Metadata = {
  title: 'Выплаты',
  description:
    'Как партнёр зарабатывает: доля по своей цене с каждого состоявшегося вызова и сообщения, выписка и выплаты в кабинете.',
};

export default async function PayoutsPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Партнёрам · выплаты"
        title="Ваша доля — по вашей цене, с каждого вызова"
        lead="Zvonix считает деньги по каждому состоявшемуся вызову и сообщению. Сколько заработано и сколько причитается, видно в кабинете."
      />

      <Section title="Из чего складывается доля">
        <FeatureGrid>
          <Feature title="Ваш тариф">
            Цена за минуту, шаг, минимальная длительность и плата за соединение — по направлениям,
            которые вы задаёте сами.
          </Feature>
          <Feature title="Только состоявшиеся" delay={60}>
            Неотвеченный вызов стоит ноль. Минимум — первый период целиком, дальше — шагами.
          </Feature>
          <Feature title="Цена на момент звонка" delay={120}>
            Условия запоминаются при вызове: смена тарифа посреди разговора его цену не меняет.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section title="Где это видно">
        <FeatureGrid>
          <Feature title="Выписка">
            Начислено и причитается — за вызовы и сообщения MAX, по операторам, шлюзам, SIM и
            аккаунтам.
          </Feature>
          <Feature title="Деньги" delay={60}>
            Заработано, к выплате и журнал всех начислений и выплат.
          </Feature>
          <Feature title="Выплата" delay={120}>
            Zvonix переводит деньги и отмечает выплату — она сразу видна в журнале. Больше
            причитающегося выплатить нельзя.
          </Feature>
        </FeatureGrid>
        <p className="mt-6 max-w-2xl text-muted-foreground">
          Сроки и способ перевода уточняйте в поддержке.
        </p>
      </Section>

      <CallToAction
        cabinetUrl={info.cabinetUrl}
        title="Оставьте заявку партнёра"
        text="Регистрация занимает несколько минут: укажите контакты и подтвердите почту."
        partner
      />
    </>
  );
}
