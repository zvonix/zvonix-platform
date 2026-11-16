import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section, Steps } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Подключение оборудования',
  description:
    'Что нужно партнёру: GOIP-шлюз, телефон Android или свой SIP-провайдер. Подключение из кабинета, проверка «на связи», тестовый звонок.',
};

export default async function EquipmentPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Партнёрам · оборудование"
        title="Подключите оборудование сами, из кабинета"
        lead="Шлюзы, SIM и SIP-провайдеров партнёр заводит и включает сам. Кабинет показывает, что ввести в устройство, и проверяет, на связи ли оно."
      />

      <Section title="Что можно подключить">
        <FeatureGrid>
          <Feature title="GOIP-шлюз">
            Один вход на шлюз или свой вход у каждой линии (Config by Line). Кабинет показывает
            настройки шлюза по шагам.
          </Feature>
          <Feature title="Телефон Android" delay={60}>
            Один слот под SIM. На линии, где клиенту нужна запись разговора, вызовы через телефон не
            идут: на Android она недоступна.
          </Feature>
          <Feature title="Свой SIP-провайдер" delay={120}>
            Адрес, логин и пароль из кабинета провайдера. Адрес — только внешний.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section title="Как подключить">
        <Steps
          items={[
            {
              title: 'Добавьте шлюз',
              text: 'Кабинет выдаст сервер, порт, логин и пароль. Пароль показывается один раз.',
            },
            {
              title: 'Введите данные в устройство',
              text: 'Шлюз входит на АТС Zvonix; кабинет видит, с какого адреса он вошёл.',
            },
            {
              title: 'Вставьте SIM и включите',
              text: 'Оператор номера определяется сам; совпал с заявленным — SIM включается.',
            },
          ]}
        />
      </Section>

      <Section title="Проверка">
        <FeatureGrid>
          <Feature title="Допуск партнёра">
            Регистрация — заявка; трафик идёт, только когда Zvonix допустил партнёра к работе.
          </Feature>
          <Feature title="«На связи»" delay={60}>
            Узел опрашивается раз в минуту. Шлюз на связи, если его вход действует и виден не дольше
            трёх минут назад.
          </Feature>
          <Feature title="Тестовый звонок" delay={120}>
            Бесплатный пробный звонок с выбранной SIM на указанный номер: ответивший слышит пять
            сигналов, кабинет показывает итог.
          </Feature>
          <Feature title="Тревога">
            Если шлюз почти не соединяет, кабинет помечает его, а вам приходит письмо — не чаще раза
            в 12 часов.
          </Feature>
          <Feature title="Включение после пробы" delay={60}>
            Шлюз или провайдера, отключённых автоматически, вы включаете сами после удачного
            тестового звонка.
          </Feature>
          <Feature title="Пределы" delay={120}>
            До 50 шлюзов, 1000 SIM и 20 SIP-провайдеров на партнёра.
          </Feature>
        </FeatureGrid>
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
