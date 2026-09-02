/**
 * Токены внедрения зависимостей.
 *
 * Конфигурация и логгер — не классы, а значения, поэтому контейнер NestJS не может
 * найти их по типу и им нужны явные токены. Собраны в одном файле, чтобы не появилось
 * двух символов с одинаковым именем в разных модулях: такие подменяются молча.
 */

import type { Config } from '@zvonix/config';
import type { Logger } from '@zvonix/logger';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const APP_LOGGER = Symbol('APP_LOGGER');

/**
 * Имя процесса в логах: `api`, `worker`, дальше — `esl`.
 *
 * Без него записи двух процессов неразличимы: оба поднимают одни и те же доменные
 * модули, и строка «резерв освобождён» выглядит одинаково независимо от того, кто
 * её написал — обработчик запроса или проход уборки (ADR-0020).
 */
export const PROCESS_COMPONENT = Symbol('PROCESS_COMPONENT');

export type { Config, Logger };
