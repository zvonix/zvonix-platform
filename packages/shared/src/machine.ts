/**
 * Перечисления машинного доступа (ADR-0019).
 */

/**
 * Вид машинного ключа.
 *
 * `node`       — узел АТС: запрос маршрута, CDR, heartbeat, выгрузка записей.
 *                Срок жизни не задаётся: истёкший ключ узла — это отказ телефонии;
 * `client_api` — служба такси: инициация вызовов и статусы в пределах своего клиента;
 * `enrollment` — одноразовый токен установки. Живёт час, применяется один раз
 *                и обменивается на постоянный ключ узла. Существует потому, что команда
 *                установки попадает в историю оболочки и в переписку.
 */
export const MACHINE_KEY_KINDS = ['node', 'client_api', 'enrollment'] as const;
export type MachineKeyKind = (typeof MACHINE_KEY_KINDS)[number];

/**
 * Видимая часть идентификатора ключа: `zvx_node_a1b2c3d4e5f6`.
 *
 * Короткое обозначение вида, а не само значение перечисления: идентификатор произносят
 * вслух в поддержке и ищут глазами в логах.
 */
const KIND_TAGS: Readonly<Record<MachineKeyKind, string>> = {
  node: 'node',
  client_api: 'client',
  enrollment: 'enroll',
};

const TAG_KINDS: ReadonlyMap<string, MachineKeyKind> = new Map(
  Object.entries(KIND_TAGS).map(([kind, tag]) => [tag, kind as MachineKeyKind]),
);

export function keyIdTag(kind: MachineKeyKind): string {
  return KIND_TAGS[kind];
}

/**
 * Вид ключа, обозначенный в идентификаторе.
 *
 * Возвращённое значение — **подсказка для журнала, а не основание для доступа**: вид берётся
 * из строки, которую прислала вызывающая сторона. Настоящий вид лежит в базе рядом с хешем
 * секрета, и решение принимается по нему.
 */
export function keyIdKind(keyId: string): MachineKeyKind | undefined {
  const tag = /^zvx_([a-z]+)_[0-9a-z]+$/.exec(keyId)?.[1];
  return tag === undefined ? undefined : TAG_KINDS.get(tag);
}
