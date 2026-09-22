/**
 * Перечисления узлов АТС (ADR-0009).
 */

/**
 * Жизненный цикл узла (DOMAIN.md).
 *
 * `provisioned`    — запись заведена администратором, установка не начиналась.
 *                    Команда установки выдана, узел ещё не отвечает;
 * `installing`     — токен установки применён, узел получил ключ и настраивается;
 * `online`         — присылает heartbeat, принимает вызовы;
 * `degraded`       — отвечает, но с оговорками: часть шлюзов не зарегистрирована,
 *                    нагрузка выше порога;
 * `offline`        — молчит дольше порога. Новые вызовы на него не направляются;
 * `decommissioned` — выведен из эксплуатации навсегда. Ключи отозваны, запись остаётся:
 *                    на узел ссылаются CDR, а их не удаляют никогда.
 */
export const NODE_STATUSES = [
  'provisioned',
  'installing',
  'online',
  'degraded',
  'offline',
  'decommissioned',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Состояния, в которых узел принимает вызовы. */
export const ROUTABLE_NODE_STATUSES: readonly NodeStatus[] = ['online', 'degraded'];

export function isRoutableNodeStatus(status: NodeStatus): boolean {
  return ROUTABLE_NODE_STATUSES.includes(status);
}

/**
 * Сколько узел может молчать, прежде чем считается недоступным.
 *
 * Втрое дольше ожидаемого интервала heartbeat: один потерянный пакет не должен
 * снимать узел с маршрутизации, а три подряд — уже должны.
 */
export const NODE_HEARTBEAT_INTERVAL_MS = 30_000;
export const NODE_OFFLINE_AFTER_MS = 3 * NODE_HEARTBEAT_INTERVAL_MS;
