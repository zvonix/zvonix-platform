import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Адрес API в разработке.
 *
 * Только в разработке: в production кабинет и API видны по одному адресу, и делит
 * его обратный прокси ([ADR-0037](../../docs/adr/0037-sessiya-v-brauzere.md)).
 * Гонять весь живой опрос состояний через лишний процесс Node было бы платой
 * без покупки — cookie одинаково работает и так, и так.
 */
const apiOrigin = process.env['ZVONIX_API_ORIGIN'] ?? 'http://127.0.0.1:8000';

/**
 * Заголовки, которые не зависят от страницы.
 *
 * Политику содержимого целиком здесь не задать: Next вставляет свои встроенные
 * сценарии, и `script-src` без одноразовых меток их запретит. Задано то, что
 * действует и без этого, — запрет встраивания в чужую страницу, чужих плагинов
 * и подмены основы для относительных адресов. Полная политика — хвост в TASKS.md.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Content-Security-Policy',
    value: ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"].join('; '),
  },
];

const nextConfig: NextConfig = {
  // Next 16 при запуске пишет в пакет свои CLAUDE.md и AGENTS.md с общими советами
  // по себе. У проекта правила свои, они в корневом CLAUDE.md, и второй набор рядом
  // с кодом — это указания, которые никто не писал и не сверял.
  agentRules: false,

  // Самодостаточная сборка: в образ кладётся только то, что действительно нужно
  // для запуска, а не всё дерево node_modules.
  output: 'standalone',

  // Монорепозиторий: без явного корня Next ищет его по ближайшему lock-файлу
  // и в рабочем пространстве pnpm ошибается.
  // Через `fileURLToPath`, а не `.pathname`: тот отдаёт адрес в кодировке URL,
  // и кириллица в пути до репозитория превращается в проценты (правило 5).
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),

  // Next закрывает свои dev-ресурсы от чужих источников, и `127.0.0.1` для него
  // чужой, даже когда он же слушает. Симптом коварный: страница отдаётся, но не
  // оживает — форма отправляется браузером, а не кабинетом. Перечислено оба имени.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
};

export default nextConfig;
