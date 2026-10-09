/**
 * Полная схема базы.
 *
 * Единственное место, которое видят и drizzle-kit при генерации миграций, и приложение
 * при запросах. Новая таблица, не попавшая сюда, не окажется ни в миграции, ни в типах.
 */

export { users, sessions } from './users.js';
export { auditLog } from './audit-log.js';
export { platformSettings } from './settings.js';
export {
  operators,
  operatorAliases,
  numberingPlanRanges,
  numberResolutions,
  blockedNumbers,
} from './catalog.js';
export {
  clients,
  partners,
  partnerAliases,
  accounts,
  ledgerTransactions,
  ledgerEntries,
} from './billing.js';
export { machineCredentials } from './machine.js';
export { nodes } from './nodes.js';
export {
  gateways,
  sipTrunks,
  channels,
  simCards,
  gatewayPorts,
  channelPartnerPriorities,
  channelAllowedOperators,
  partnerCoverage,
  testCalls,
} from './telephony.js';
export { partnerTariffs, partnerRates, priceBands, commissionRules } from './tariffs.js';
export { calls, reservations } from './calls.js';
export { recordings, recordingGrants } from './recordings.js';
export { limitRules, limitCounters } from './limits.js';
export { failureThresholds } from './quality.js';
export { outboxMessages, authTokens } from './mail.js';
export { applications } from './applications.js';
export { payments } from './payments.js';
export { serverMetrics } from './server-metrics.js';
export {
  botConnections,
  botSubscribers,
  messengerAccounts,
  partnerDistributions,
  messengerBots,
  messengerTariffs,
  messages,
  smppAccounts,
} from './messenger.js';
