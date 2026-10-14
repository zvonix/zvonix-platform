import type { Metadata } from 'next';
import { CallToAction, PageHeader, Section } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Вопросы и ответы',
  description: 'Ответы на частые вопросы клиентов и партнёров площадки.',
};

const QUESTIONS: readonly { q: string; a: string }[] = [
  {
    q: 'Кому подходит площадка?',
    a: 'Любым компаниям и сервисам, которым нужно звонить и отправлять уведомления своим клиентам: доставка, такси, интернет-магазины, салоны и клиники, а также владельцам GSM-шлюзов и SIM, которые хотят загрузить оборудование.',
  },
  {
    q: 'Нужно ли мне своё оборудование?',
    a: 'Клиенту — нет: вызовы идут через оборудование партнёров. Партнёру нужны GSM-шлюзы и SIM.',
  },
  {
    q: 'Как формируется цена?',
    a: 'Цена партнёра плюс наценка площадки. Тариф посекундный или поминутный, состав цены виден в кабинете.',
  },
  {
    q: 'Что если у партнёра закончился лимит или SIM занята?',
    a: 'Площадка берёт следующее предложение по вашим приоритетам и цене; отказ только если подходящих нет.',
  },
  {
    q: 'Видит ли партнёр моих клиентов?',
    a: 'Нет. Партнёр видит вызовы своих SIM и свои деньги, но не вас и не ваши цены. Вы видите партнёров по псевдонимам.',
  },
  {
    q: 'Как пополнить счёт?',
    a: 'Подайте заявку на пополнение в кабинете с реквизитами перевода. После подтверждения администратором баланс обновляется.',
  },
  {
    q: 'Что с записями разговоров?',
    a: 'Записи хранятся на площадке и слушаются по временным ссылкам; каждое прослушивание остаётся в журнале.',
  },
  {
    q: 'Можно ли отправлять сообщения MAX?',
    a: 'Да, из кабинета, по HTTP API или по SMPP. Сообщение уходит через аккаунт партнёра или через бота MAX.',
  },
];

export default async function FaqPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Вопросы"
        title="Частые вопросы"
        lead="Если вашего вопроса нет, напишите нам: контакты — внизу страницы."
      />
      <Section>
        <div className="grid max-w-3xl gap-3">
          {QUESTIONS.map((item) => (
            <details
              key={item.q}
              className="group rounded-lg border border-border bg-card p-4 open:border-primary"
            >
              <summary className="cursor-pointer list-none font-medium marker:content-none">
                {item.q}
              </summary>
              <p className="mt-2 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </Section>
      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
