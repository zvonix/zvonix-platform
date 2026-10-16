import type { Metadata } from 'next';
import { CallPath, CallToAction, Feature, FeatureGrid, PageHeader, Section } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Как это работает',
  description:
    'Путь вызова от вашей системы через площадку и узел АТС до абонента, и как считаются деньги.',
};

export default async function HowItWorksPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Как это работает"
        title="Один вызов — от вашей системы до телефона абонента"
        lead="Площадка выбирает, через чью SIM пройдёт вызов, ведёт его на нашей АТС и считает деньги по итогам разговора."
      />

      <Section title="Путь вызова">
        <CallPath />
      </Section>

      <Section
        title="Путь сообщения"
        lead="Тот же принцип, что у звонка: вы отправляете запрос, площадка выбирает канал и считает деньги."
      >
        <FeatureGrid>
          <Feature title="1. Приём">
            Сообщение приходит из кабинета, по HTTP API или по протоколу SMPP — как обычное SMS.
          </Feature>
          <Feature title="2. Канал" delay={60}>
            Через аккаунт партнёра или через бота площадки (сейчас MAX); при необходимости площадка
            заранее проверяет, что у номера есть мессенджер.
          </Feature>
          <Feature title="3. Отчёт" delay={120}>
            Статусы «отправлено», «доставлено», «прочитано» возвращаются отчётом SMPP или в
            кабинете; за неотправленное деньги возвращаются.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section
        title="Как площадка выбирает партнёра"
        lead="Решение занимает доли секунды и не требует вашего участия."
      >
        <FeatureGrid>
          <Feature title="1. Отбор">
            Остаются только те SIM, у которых есть цена на этот номер, которые свободны и не
            исчерпали лимит.
          </Feature>
          <Feature title="2. Порядок" delay={60}>
            Сначала ваши приоритеты, внутри одной цифры — по цене, при равной цене — кто дольше не
            получал вызовов.
          </Feature>
          <Feature title="3. Следующий" delay={120}>
            Если SIM занята или исчерпала лимит, берётся следующая, а не отказ.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section
        title="Как считаются деньги"
        lead="Деньги меняются проводками по итогам разговора, а не «на глаз»."
      >
        <ul className="grid max-w-3xl gap-3 text-muted-foreground">
          <li className="rounded-lg border border-border bg-card p-4">
            <span className="font-medium text-foreground">До звонка</span> — на счёте клиента
            придерживается сумма вызова: если денег не хватает, вызов не состоится.
          </li>
          <li className="rounded-lg border border-border bg-card p-4">
            <span className="font-medium text-foreground">После разговора</span> — списывается
            стоимость по тарифу партнёра с наценкой площадки; повторная отправка итога вызова не
            списывает второй раз.
          </li>
          <li className="rounded-lg border border-border bg-card p-4">
            <span className="font-medium text-foreground">Не дозвонились</span> — резерв снимается,
            деньги не двигаются.
          </li>
        </ul>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
