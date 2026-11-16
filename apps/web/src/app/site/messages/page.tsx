import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section, Steps } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Сообщения',
  description:
    'Уведомления вашим клиентам в мессенджер: из кабинета, по HTTP API или SMPP, отчёты о доставке, оплата только за отправленное.',
};

export default async function MessagesPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Клиентам · сообщения"
        title="Сообщения клиентам — привычным способом, как SMS"
        lead="Уведомление уходит вашему клиенту в мессенджер (сейчас MAX), а вы отправляете его из кабинета, по API или по протоколу SMPP."
      />

      <Section title="Как начать">
        <Steps
          items={[
            {
              title: 'Выберите способ',
              text: 'Из кабинета вручную, по HTTP API из вашей системы или по протоколу SMPP — как в обычных SMS-системах.',
            },
            {
              title: 'Получите доступ',
              text: 'Для SMPP кабинет выдаёт логин и пароль (показываются один раз), для API — ключ. Можно ограничить доступ по адресам.',
            },
            {
              title: 'Отправляйте и получайте отчёты',
              text: 'Отчёты о доставке приходят тем же протоколом. Деньги списываются только за отправленное.',
            },
          ]}
        />
      </Section>

      <Section title="Что есть в кабинете">
        <FeatureGrid>
          <Feature title="Текст сообщения">
            Соберите сообщение из частей: приветствие, свой текст, сам текст, ссылка на бота — в
            каждое сообщение или только в первое. Цена от этого не меняется.
          </Feature>
          <Feature title="Бот MAX" delay={60}>
            Сообщения от бота Zvonix или от вашего собственного бота.
          </Feature>
          <Feature title="Аккаунты партнёров" delay={120}>
            Доставка через аккаунты партнёров Zvonix; очерёдность — в разделе «Маршруты».
          </Feature>
          <Feature title="Статусы">
            Отправлено, доставлено, прочитано — по каждому сообщению.
          </Feature>
          <Feature title="Цены" delay={60}>
            Цены сообщений — в кабинете. Неотправленное не оплачивается.
          </Feature>
          <Feature title="Повтор без дублей" delay={120}>
            Свой идентификатор сообщения делает повтор безопасным: деньги не спишутся дважды.
          </Feature>
        </FeatureGrid>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
