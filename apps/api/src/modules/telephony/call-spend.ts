/**
 * Решения о деньгах идущих разговоров ([ADR-0126](../../../../../docs/adr/0126-dengi-na-zvonok-bez-rezerva.md)).
 *
 * Здесь только расчёт: ни базы, ни узла. Оба решения — пускать ли звонок и какие обрывать — проверяются таблицей
 * случаев, как тарификация: ошибка здесь не падает, а молча обрывает чужой разговор или пускает клиента глубоко в минус.
 */

import { Money, type MoneyAmount } from '@zvonix/shared';

/**
 * Можно ли начать звонок.
 *
 * `headroom` — остаток + разрешённый минус − резервы − стоимость остальных идущих разговоров клиента. Звонок
 * начинается, если это больше нуля (10 копеек — уже можно) и хватает на плату за соединение самого звонка.
 */
export function startAllowed(headroom: MoneyAmount, connection: MoneyAmount): boolean {
  return Money.compare(headroom, Money.ZERO) > 0 && Money.compare(headroom, connection) >= 0;
}

/** Идущий разговор с его стоимостью на сейчас. */
export interface SpendingCall<Id = string> {
  readonly id: Id;
  readonly cost: MoneyAmount;
  /** Уже оборван и ждёт CDR: стоимость учитывается, второй раз не обрывается. */
  readonly cutOff: boolean;
}

/**
 * Какие разговоры оборвать, чтобы клиент уложился в свой минус.
 *
 * `available` — остаток + разрешённый минус − резервы. `calls` — все открытые вызовы клиента, **свежие сверху**.
 * Пока сумма их стоимости больше доступного, обрывается самый новый из ещё не оборванных, и его стоимость
 * вычитается. Короткий разговор потерять дешевле, чем прервать длинный на середине.
 *
 * Вычитается стоимость, которая всё равно будет списана: сам обрыв уже потраченного не вернёт, он останавливает
 * рост. Если и после CDR оборванных клиент за пределом, следующий проход оборвёт следующий по новизне.
 */
export function callsToCut<Id>(
  available: MoneyAmount,
  calls: readonly SpendingCall<Id>[],
): SpendingCall<Id>[] {
  let spent = calls.reduce((total, call) => Money.add(total, call.cost), Money.ZERO);
  const cut: SpendingCall<Id>[] = [];
  for (const call of calls) {
    if (Money.compare(spent, available) <= 0) break;
    if (call.cutOff) continue;
    cut.push(call);
    spent = Money.subtract(spent, call.cost);
  }
  return cut;
}

/**
 * Сколько секунд считать идущему разговору: от выдачи маршрута до сейчас, но не меньше одной.
 *
 * Момент ответа площадка узнаёт только из CDR, поэтому гудки идут как разговор — оценка завышена на время
 * дозвона, но не занижена. Секунда минимум: у только что начатого звонка стоимость — плата за соединение
 * и минимальная длительность, а не ноль.
 */
export function elapsedSeconds(startedAt: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
}

/** Идентификатор канала FreeSWITCH. Ничего другого в `uuid_kill` узлу не уходит. */
export const NODE_CALL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
