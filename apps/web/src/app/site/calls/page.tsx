import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section, Steps } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Звонки',
  description:
    'Звонки вашим клиентам через SIM партнёров Zvonix: линия SIP для вашей АТС, цена до звонка, лимиты, приоритеты, записи.',
};

export default async function CallsPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Клиентам · звонки"
        title="Звонки вашим клиентам — без своих SIM и шлюзов"
        lead="Ваша АТС звонит на линию Zvonix, вызов уходит в сотовую сеть через SIM партнёра. Вы платите за состоявшиеся вызовы."
      />

      <Section title="Как начать">
        <Steps
          items={[
            {
              title: 'Зарегистрируйтесь',
              text: 'Укажите название и контакты, подтвердите почту. Допуск к работе — по правилам сервиса.',
            },
            {
              title: 'Пополните счёт',
              text: 'Подайте заявку на пополнение; после подтверждения баланс виден в кабинете.',
            },
            {
              title: 'Подключите линию',
              text: 'Заведите линию в кабинете и введите сервер, логин и пароль в свою АТС.',
            },
          ]}
        />
      </Section>

      <Section
        title="Что вы контролируете"
        lead="Цена, лимиты и порядок партнёров — у вас в кабинете."
      >
        <FeatureGrid>
          <Feature title="Цена до звонка">
            Список предложений с вашей ценой за вызов в 60 секунд и составом тарифа: шаг, минимум,
            плата за соединение.
          </Feature>
          <Feature title="Лимиты" delay={60}>
            Минуты и количество вызовов в сутки, неделю и месяц; отдельные лимиты для линий.
          </Feature>
          <Feature title="Маршруты" delay={120}>
            Один список на клиента: цифра от 1 до 99, одинаковая цифра — по очереди, «не
            использовать» — исключить.
          </Feature>
          <Feature title="Разрешённые операторы">
            Для линии можно задать операторов, на которые разрешено звонить.
          </Feature>
          <Feature title="Записи и разбор" delay={60}>
            Записи разговоров по вашим вызовам и понятная причина каждого отказа без внутренних
            кодов.
          </Feature>
          <Feature title="API" delay={120}>
            Список вызовов, карточка вызова и баланс — по ключу из кабинета.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section
        title="Партнёры вам не видны"
        lead="Zvonix скрывает, кто именно звонит: вы выбираете по псевдониму и цене, а не по имени и номерам SIM."
      >
        <p className="max-w-2xl text-muted-foreground">
          Это защита обеих сторон: партнёр не видит ваших клиентов и цены, вы не видите его
          реквизитов и оборудования.
        </p>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
