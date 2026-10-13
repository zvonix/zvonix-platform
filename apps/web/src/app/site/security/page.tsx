import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Безопасность',
  description:
    'Как площадка защищает деньги, данные и записи разговоров: доступы, журнал, второй фактор.',
};

export default async function SecurityPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Безопасность"
        title="Деньги, данные и разговоры под контролем"
        lead="Мы строим площадку так, чтобы любое действие с деньгами и данными оставляло след, а лишнего никто не видел."
      />

      <Section title="Доступ">
        <FeatureGrid>
          <Feature title="Второй фактор">
            Вход с кодом из приложения; для сотрудников площадки он может быть обязательным.
          </Feature>
          <Feature title="Разделение ролей" delay={60}>
            Клиент и партнёр видят только своё; сотрудники — по роли, а поддержка без права менять.
          </Feature>
          <Feature title="Скрытые стороны" delay={120}>
            Клиент не видит партнёра, партнёр — клиента: только псевдонимы и собственные цифры.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section title="Следы и записи">
        <FeatureGrid>
          <Feature title="Журнал действий">
            Действия с деньгами, тарифами и лимитами записываются: кто, когда, что было и что стало.
          </Feature>
          <Feature title="Записи разговоров" delay={60}>
            Хранятся на площадке, слушаются по временным ссылкам; выдача и прослушивание попадают в
            журнал.
          </Feature>
          <Feature title="Деньги — только проводками" delay={120}>
            Баланс меняется парными записями; повторная отправка итога вызова не создаёт второго
            списания.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section title="Защита данных">
        <FeatureGrid>
          <Feature title="Шифрование">
            Соединение — только по https; секреты настроек хранятся шифротекстом.
          </Feature>
          <Feature title="Пределы и защита входа" delay={60}>
            Ограничения частоты действий и попыток входа, блокировка перебора.
          </Feature>
          <Feature title="Номера абонентов" delay={120}>
            Номера маскируются в журналах работы и не попадают в клиентский контур партнёра.
          </Feature>
        </FeatureGrid>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
