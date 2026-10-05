'use client';

import { ConsoleShell } from '@/components/console-shell';
import { BandViolations } from './band-violations';
import { CommissionRules } from './commission-rules';
import { MessageMarkup } from './message-markup';
import { PriceBands } from './price-bands';

/**
 * Тарифы и наценка.
 *
 * Порядок разделов — по срочности, а не по важности. Первым идёт нарушение коридора:
 * оно возникает само, от сужения коридора, и увидеть его больше негде. Вторым —
 * наценка платформы: без действующего правила **ни один вызов не тарифицируется**,
 * маршрутизация отказывает с причиной «нет тарифа». Третьим — коридоры: без коридора
 * по направлению партнёр не может назначить цену сам, и направление для него закрыто —
 * это заметно не сразу, а когда партнёр придёт с вопросом.
 *
 * Цен партнёров здесь нет намеренно: они принадлежат партнёру и живут в его карточке,
 * рядом с его оборудованием и его деньгами.
 *
 * Поддержке раздел открыт на чтение: нарушение коридора и отсутствие правила наценки —
 * это причины, по которым не идут вызовы, и разбирать их, не видя чисел, нельзя.
 * Действия здесь остаются за администратором и ей просто не рисуются
 * ([DESIGN.md](../../../../docs/DESIGN.md)).
 */
export default function TariffsPage() {
  return (
    <ConsoleShell title="Тарифы и наценка" requireRole={['admin', 'support']}>
      {() => (
        <div className="flex flex-col gap-6">
          <BandViolations />
          <CommissionRules />
          <MessageMarkup />
          <PriceBands />
        </div>
      )}
    </ConsoleShell>
  );
}
