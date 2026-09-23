import type { PartnerStatus } from '@zvonix/shared';
import { ApiError, request } from '@/lib/api';

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

/**
 * Один партнёр для его карточки — `GET /partners/:id`.
 * `undefined` — такого партнёра нет; негодный идентификатор в адресе — тоже «нет».
 */
export async function findPartner(
  id: string,
  signal?: AbortSignal,
): Promise<PartnerRow | undefined> {
  try {
    const found = await request<{ partner: PartnerRow }>(
      `/partners/${encodeURIComponent(id)}`,
      signal === undefined ? {} : { signal },
    );
    return found.partner;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      return undefined;
    }
    throw error;
  }
}
