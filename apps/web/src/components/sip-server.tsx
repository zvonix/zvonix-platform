/**
 * Адрес, куда устройство направляет SIP, — или честное «адреса нет»
 * ([ADR-0113](../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md)).
 *
 * `null` значит: ни у одного узла АТС адрес не задан. Раньше на его место молча вставал домен сайта,
 * и GOIP партнёра уходил на машину без телефонии — настройки выглядели верными, а линии не выходили
 * на связь (владелец, 2026-11-11). Поэтому здесь не подставляется ничего: человек видит, что ждать
 * нужно площадку, а не искать ошибку у себя.
 */
import { CopyButton } from '@/components/copy-button';

const NO_SIP_SERVER =
  'адрес для подключения ещё не задан площадкой — подключать устройство пока некуда, напишите в поддержку';

export function SipServer({ server }: { server: string | null }) {
  if (server === null) return <span className="text-warn">{NO_SIP_SERVER}</span>;
  // С кнопкой «копировать», как у логина и пароля: адрес вводят в GOIP, и опечатка в нём — линия без связи.
  return (
    <span className="inline-flex items-center gap-1">
      <span className="num select-all">{server}</span>
      <CopyButton value={server} label="Скопировать адрес" />
    </span>
  );
}
