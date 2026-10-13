import { CallPath, CallToAction, Feature, FeatureGrid, Section } from './blocks';
import { Reveal } from './reveal';
import { getSiteInfo, getSitePrices, rubles } from './site-data';

export const revalidate = 60;

export default async function HomePage() {
  const [info, prices] = await Promise.all([getSiteInfo(), getSitePrices()]);
  const register = info.cabinetUrl === '' ? '#' : `${info.cabinetUrl}/register`;

  return (
    <>
      <div className="site-hero border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-20 pt-16 md:pt-24">
          <span className="text-xs font-semibold uppercase tracking-widest text-primary">
            Площадка терминации
          </span>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-balance md:text-6xl">
            Звонки и сообщения в одном месте
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground md:text-xl">
            Службам такси — звонки пассажирам и сообщения MAX по понятным ценам. Владельцам
            GSM-оборудования — загрузка SIM и выплаты за каждую минуту.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href={register}
              className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Подать заявку
            </a>
            <a
              href="/how-it-works"
              className="rounded-md border border-border px-5 py-3 font-medium hover:bg-muted"
            >
              Как это работает
            </a>
          </div>

          <dl className="mt-6 grid gap-4 sm:grid-cols-2 md:max-w-2xl">
            <div className="rounded-lg border border-border bg-card/80 p-4">
              <dt className="text-muted-foreground">Звонок</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {prices.callFrom === null ? 'по запросу' : `от ${rubles(prices.callFrom)}`}
                {prices.callFrom !== null && (
                  <span className="text-base font-normal text-muted-foreground"> / мин</span>
                )}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-card/80 p-4">
              <dt className="text-muted-foreground">Сообщение MAX</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {prices.messageFrom === null ? 'по запросу' : `от ${rubles(prices.messageFrom)}`}
                {prices.messageFrom !== null && (
                  <span className="text-base font-normal text-muted-foreground"> / сообщение</span>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <Section
        title="Для кого"
        lead="Две стороны одной площадки: кто звонит и кто принимает вызов на свою SIM."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Reveal>
            <a
              href="/clients"
              className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary"
            >
              <h3 className="text-xl font-semibold">Службам такси</h3>
              <p className="text-muted-foreground">
                Звонки пассажирам и сообщения MAX через одну площадку. Вы видите цену, ставите
                лимиты и сами решаете, через кого звонить в первую очередь.
              </p>
              <span className="mt-auto font-medium text-primary group-hover:underline">
                Подробнее →
              </span>
            </a>
          </Reveal>
          <Reveal delay={80}>
            <a
              href="/partners"
              className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary"
            >
              <h3 className="text-xl font-semibold">Партнёрам с GSM-оборудованием</h3>
              <p className="text-muted-foreground">
                Подключите шлюзы и SIM, задайте цену по операторам и получайте свою долю с каждого
                состоявшегося вызова. Выплаты и выписка — в кабинете.
              </p>
              <span className="mt-auto font-medium text-primary group-hover:underline">
                Подробнее →
              </span>
            </a>
          </Reveal>
        </div>
      </Section>

      <Section
        title="Путь вызова"
        lead="От вашей системы до телефона пассажира — через нашу АТС и GSM-шлюз партнёра."
      >
        <CallPath />
      </Section>

      <Section title="Что есть на площадке">
        <FeatureGrid>
          <Feature title="Прозрачная цена">
            Цена партнёра плюс наценка площадки. Тариф посекундный или поминутный — это видно до
            звонка.
          </Feature>
          <Feature title="Лимиты и приоритеты" delay={60}>
            Минуты в сутки и в месяц, частота звонков с одной SIM, порядок партнёров цифрами 1–99.
          </Feature>
          <Feature title="Запись разговоров" delay={120}>
            Записи хранятся на площадке, слушать их можно по временным ссылкам; каждое прослушивание
            остаётся в журнале.
          </Feature>
          <Feature title="Сообщения MAX">
            Через аккаунты партнёров, через бота MAX, по HTTP API или по SMPP — с той же ценой,
            лимитами и возвратом.
          </Feature>
          <Feature title="Отчёты и акт" delay={60}>
            Вызовы с причинами отказов, итоги за период, акт за месяц с остатком на начало и конец,
            выгрузка в CSV.
          </Feature>
          <Feature title="Пополнение по заявке" delay={120}>
            Заявка на пополнение подтверждается администратором, баланс виден в кабинете,
            уведомление о низком остатке — по почте.
          </Feature>
        </FeatureGrid>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
