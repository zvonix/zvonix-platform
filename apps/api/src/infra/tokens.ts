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

export type { Config, Logger };
