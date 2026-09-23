import type { PartnerStatus } from '@zvonix/shared';
import { request } from '@/lib/api';

/** Строка `GET /partners` ([billing.md](../../../../../docs/api/billing.md)). */
export interface PartnerRow {
  readonly id: string;
  /** Настоящее имя. В клиентский контур не попадает: этот экран административный. */
  readonly name: string;
  readonly display_name: string | null;
  readonly status: PartnerStatus;
  readonly listens_to_recordings: boolean;
  readonly balance: string;
  readonly created_at: string;
}

/** Больше API за раз не отдаёт (`PARTNER_PAGE_MAX`): просить больше бесполезно. */
const PAGE = 200;

/**
 * Один партнёр для его карточки.
 *
 * Обработчика `GET /partners/:id` нет, поэтому карточка берёт тот же список, что
 * и таблица, и ищет в нём по идентификатору, листая страницы до конца. Отбор по имени
 * тут не помощник: он ищет по части имени и псевдонима, а не по идентификатору.
 * `undefined` — такого партнёра нет вовсе, а не «не нашёлся на первой странице».
 */
export async function findPartner(
  id: string,
  signal?: AbortSignal,
): Promise<PartnerRow | undefined> {
  for (let offset = 0; ; offset += PAGE) {
    const page = await request<{ partners: PartnerRow[]; total: number }>(
      `/partners?limit=${String(PAGE)}&offset=${String(offset)}`,
      signal === undefined ? {} : { signal },
    );
    const found = page.partners.find((partner) => partner.id === id);
    if (found !== undefined) return found;
    if (page.partners.length === 0 || offset + PAGE >= page.total) return undefined;
  }
}
