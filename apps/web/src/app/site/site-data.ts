/**
 * Данные сайта: контакты и цены «от» с открытых обработчиков API
 * ([ADR-0082](../../../../../docs/adr/0082-sayt-proekta.md), `docs/api/public.md`).
 *
 * Читаются на сервере при отрисовке страницы и кешируются на минуту: посетителю сайта API
 * недоступен напрямую, а сайт обязан открываться, даже если API не отвечает, — тогда страница
 * показывается без контактов и с «по запросу».
 */

const API_ORIGIN = process.env['ZVONIX_API_ORIGIN'] ?? 'http://127.0.0.1:8000';
const REVALIDATE_SECONDS = 60;
const TIMEOUT_MS = 3_000;

export interface SiteInfo {
  readonly companyName: string;
  readonly email: string;
  readonly phone: string;
  readonly telegram: string;
  readonly workingHours: string;
  /** Куда ведут «Войти» и «Зарегистрироваться»; пусто — на тот же адрес, где открыт сайт (кабинет рядом). */
  readonly cabinetUrl: string;
  readonly siteUrl: string | null;
}

export interface SitePrices {
  /** Цена минуты звонка для клиента, ₽; `null` — «по запросу». */
  readonly callFrom: string | null;
  /** Цена одного сообщения MAX, ₽; `null` — «по запросу». */
  readonly messageFrom: string | null;
}

const EMPTY_INFO: SiteInfo = {
  companyName: '',
  email: '',
  phone: '',
  telegram: '',
  workingHours: '',
  cabinetUrl: '',
  siteUrl: null,
};

const EMPTY_PRICES: SitePrices = { callFrom: null, messageFrom: null };

async function read(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    // Сайт без контактов лучше, чем сайт, который не открывается из-за недоступного API.
    return undefined;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function getSiteInfo(): Promise<SiteInfo> {
  const body = await read('/public/site');
  if (body === undefined) return EMPTY_INFO;
  return {
    companyName: text(body['company_name']),
    email: text(body['email']),
    phone: text(body['phone']),
    telegram: text(body['telegram']),
    workingHours: text(body['working_hours']),
    cabinetUrl: text(body['cabinet_url']),
    siteUrl: maybe(body['site_url']),
  };
}

export async function getSitePrices(): Promise<SitePrices> {
  const body = await read('/public/prices');
  if (body === undefined) return EMPTY_PRICES;
  return { callFrom: maybe(body['call_from']), messageFrom: maybe(body['message_from']) };
}

/** Сумма в рублях по-русски: `0.54` → «0,54 ₽». */
export function rubles(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ₽`;
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)} ₽`;
}

/** Ссылка на телефон для `tel:`: только цифры и плюс. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/gu, '')}`;
}

/** Ссылка на Telegram из `@имя`, `имя` или готовой ссылки. */
export function telegramHref(value: string): string {
  if (/^https?:\/\//u.test(value)) return value;
  return `https://t.me/${value.replace(/^@/u, '')}`;
}
