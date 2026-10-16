import type { Metadata } from 'next';
import { CallToAction, Feature, FeatureGrid, PageHeader, Section } from '../blocks';
import { getSiteInfo } from '../site-data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Интеграция',
  description: 'Подключение по HTTP API и SMPP: вызовы, баланс, отправка сообщений.',
};

const EXAMPLE = `curl https://<кабинет>/api/v1/balance \\
  -H "Authorization: Bearer <ключ>"

curl -X POST https://<кабинет>/api/v1/messages \\
  -H "Authorization: Bearer <ключ>" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"79001234567","text":"Машина подана","externalId":"order-17"}'`;

export default async function IntegrationPage() {
  const info = await getSiteInfo();
  return (
    <>
      <PageHeader
        eyebrow="Интеграция"
        title="Подключите свою систему за вечер"
        lead="Ключ выпускается в кабинете. Всё, что видно в кабинете, доступно и по API."
      />

      <Section title="Что доступно">
        <FeatureGrid>
          <Feature title="HTTP API">
            Список вызовов и карточка вызова, баланс, отправка и статусы сообщений. Доступ — по
            ключу клиента.
          </Feature>
          <Feature title="Повтор без дублей" delay={60}>
            Свой идентификатор сообщения делает повтор безопасным: деньги не спишутся дважды.
          </Feature>
          <Feature title="SMPP" delay={120}>
            Протокол 3.4 для отправки и отчётов о доставке; кириллица в UCS-2, длинные тексты
            частями.
          </Feature>
        </FeatureGrid>
      </Section>

      <Section title="Пример">
        <pre className="num overflow-x-auto rounded-lg border border-border bg-card p-5 text-sm leading-relaxed">
          {EXAMPLE}
        </pre>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Полное описание, коды ответов и пределы частоты — в документации для клиентов после
          подключения.
        </p>
      </Section>

      <CallToAction cabinetUrl={info.cabinetUrl} />
    </>
  );
}
