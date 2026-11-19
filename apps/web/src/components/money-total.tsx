'use client';

import { HintText } from '@/components/status-dot';
import { exactMoney, moneyTotal } from '@/lib/money';

/**
 * Итог до копеек, точное значение — в подсказке ([DESIGN.md](../../../../docs/DESIGN.md), «Деньги»).
 *
 * Подсказка появляется, только если округление что-то спрятало: у `12,34 ₽` прятать нечего. Открывается
 * наведением, фокусом и нажатием, как у состояний в таблицах, — на телефоне наведения нет.
 *
 * `inLink` — сумма внутри ссылки (плитка «Обзора» целиком ведёт в сводку): кнопка внутри ссылки — неверная
 * разметка, нажатие ушло бы в переход. Тогда точное значение — в `title`, а на телефоне его видно
 * по нажатию в самой сводке, куда ведёт плитка.
 */
export function MoneyTotal({ value, inLink = false }: { value: string; inLink?: boolean }) {
  const shown = moneyTotal(value);
  const exact = exactMoney(value);
  if (exact === undefined) return <span className="num whitespace-nowrap">{shown}</span>;
  if (inLink) {
    return (
      <span className="num whitespace-nowrap" title={`точно ${exact}`}>
        {shown}
      </span>
    );
  }
  return <HintText label={shown} reason={`точно ${exact}`} />;
}
