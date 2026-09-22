/**
 * Сквозной идентификатор запроса (ADR-0004).
 *
 * Создаётся на входной границе — HTTP-запрос, задача из очереди, событие от узла АТС —
 * и дальше сопровождает всё, что происходит по этому поводу. Без него записи одного
 * вызова невозможно собрать вместе, а разбор инцидента превращается в чтение логов подряд.
 *
 * `AsyncLocalStorage` выбран сознательно: альтернатива — протаскивать идентификатор
 * параметром через каждый слой, и он будет забыт в первой же функции, которую добавят
 * позже.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface LogContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Выполняет работу в контексте с заданным идентификатором.
 *
 * Если идентификатор пришёл извне — от клиента или соседнего сервиса — передаём его,
 * чтобы цепочка не разрывалась на границе систем. Иначе создаётся новый.
 */
export function runWithCorrelationId<T>(correlationId: string | undefined, work: () => T): T {
  return storage.run({ correlationId: correlationId ?? newCorrelationId() }, work);
}

/**
 * Входит в контекст без обёртывания работы.
 *
 * Нужно там, где обработчик нельзя обернуть вызовом: в хуке HTTP-сервера, который
 * только помечает запрос, а сам обработчик будет вызван позже, уже за пределами
 * нашего стека. `enterWith` задаёт контекст текущему асинхронному ходу выполнения
 * и всем его продолжениям, то есть остатку обработки этого запроса.
 *
 * Везде, где обработчик можно обернуть, используется `runWithCorrelationId`:
 * он ограничивает контекст явными рамками, и его нельзя случайно «оставить включённым».
 */
export function enterCorrelationId(correlationId?: string): string {
  const id = correlationId ?? newCorrelationId();
  storage.enterWith({ correlationId: id });
  return id;
}

/** Идентификатор текущей цепочки, если работа выполняется внутри контекста. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
