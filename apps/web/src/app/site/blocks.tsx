import type { ReactNode } from 'react';
import { Reveal } from './reveal';

/** Обычный раздел страницы: заголовок, подзаголовок, содержимое. */
export function Section({
  title,
  lead,
  children,
  id,
}: {
  title?: string;
  lead?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl px-4 pt-20">
      {title !== undefined && (
        <Reveal className="mb-8 flex max-w-2xl flex-col gap-3">
          <h2 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
            {title}
          </h2>
          {lead !== undefined && <p className="text-lg text-muted-foreground">{lead}</p>}
        </Reveal>
      )}
      {children}
    </section>
  );
}

/** Шапка внутренней страницы. */
export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead: string;
}) {
  return (
    <div className="site-hero border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-14 pt-16 md:pt-20">
        <span className="text-xs font-semibold uppercase tracking-widest text-primary">
          {eyebrow}
        </span>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance md:text-5xl">
          {title}
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{lead}</p>
      </div>
    </div>
  );
}

/** Карточка возможности. */
export function Feature({
  title,
  children,
  delay = 0,
}: {
  title: string;
  children: ReactNode;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className="h-full">
      <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-card p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-muted-foreground">{children}</p>
      </article>
    </Reveal>
  );
}

export function FeatureGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

/** Нумерованный порядок действий: номера здесь настоящие — порядок важен. */
export function Steps({ items }: { items: readonly { title: string; text: string }[] }) {
  return (
    <ol className="grid gap-4 md:grid-cols-3">
      {items.map((item, index) => (
        <Reveal key={item.title} delay={index * 80}>
          <li className="flex h-full list-none flex-col gap-2 rounded-lg border border-border bg-card p-5">
            <span className="num text-sm font-semibold text-primary">Шаг {String(index + 1)}</span>
            <h3 className="font-semibold">{item.title}</h3>
            <p className="text-muted-foreground">{item.text}</p>
          </li>
        </Reveal>
      ))}
    </ol>
  );
}

/** Призыв к действию в конце страницы. */
export function CallToAction({
  cabinetUrl,
  title = 'Начните с заявки',
  text = 'Регистрация занимает несколько минут. Подтверждаем заявки вручную, чтобы на площадке были только реальные клиенты и партнёры.',
}: {
  cabinetUrl: string;
  title?: string;
  text?: string;
}) {
  const register = cabinetUrl === '' ? '#' : `${cabinetUrl}/register`;
  const login = cabinetUrl === '' ? '#' : `${cabinetUrl}/login`;
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pt-20">
      <Reveal>
        <div className="flex flex-col items-start gap-5 rounded-xl border border-border bg-card p-8 md:flex-row md:items-center md:justify-between">
          <div className="flex max-w-xl flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            <p className="text-muted-foreground">{text}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href={register}
              className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Подать заявку
            </a>
            <a
              href={login}
              className="rounded-md border border-border px-5 py-2.5 font-medium transition-colors hover:bg-muted"
            >
              Войти
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

const PATH: readonly { title: string; text: string }[] = [
  { title: 'Клиент', text: 'Ваша АТС или приложение звонит на линию площадки.' },
  { title: 'Площадка', text: 'Выбирает партнёра: цена, лимиты, ваши приоритеты.' },
  { title: 'Узел АТС', text: 'Ведёт вызов на нашем FreeSWITCH, пишет запись.' },
  { title: 'GSM-шлюз', text: 'SIM партнёра выводит вызов в сотовую сеть.' },
  { title: 'Абонент', text: 'Получает обычный звонок.' },
];

/** Путь вызова: пять узлов, между ними бежит сигнал. Движение — только на CSS. */
export function CallPath() {
  return (
    <ol className="flex flex-col md:flex-row md:items-stretch" aria-label="Путь вызова">
      {PATH.map((node, index) => (
        <li key={node.title} className="flex flex-col md:flex-1 md:flex-row md:items-center">
          <div className="flex-1 rounded-lg border border-border bg-card p-4 md:min-h-32">
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-full bg-primary" />
              <h3 className="font-semibold">{node.title}</h3>
            </div>
            <p className="mt-1.5 text-muted-foreground">{node.text}</p>
          </div>
          {index < PATH.length - 1 && (
            <span
              aria-hidden
              data-step={String((index % 4) + 1)}
              className="site-flow-line mx-auto h-8 w-0.5 md:h-0.5 md:w-8"
            />
          )}
        </li>
      ))}
    </ol>
  );
}
