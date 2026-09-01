/**
 * Полная схема базы.
 *
 * Единственное место, которое видят и drizzle-kit при генерации миграций, и приложение
 * при запросах. Новая таблица, не попавшая сюда, не окажется ни в миграции, ни в типах.
 */

export { users, sessions } from './users.js';
export { auditLog } from './audit-log.js';
export { operators, operatorAliases, numberingPlanRanges, numberResolutions } from './catalog.js';
export {
  clients,
  partners,
  partnerAliases,
  accounts,
  ledgerTransactions,
  ledgerEntries,
} from './billing.js';
