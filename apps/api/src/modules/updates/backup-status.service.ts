/**
 * Резервные копии: чтение `backups.json`, который пишет служба обновления
 * ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * Отдельно от `BackupsService`: список нужен и тревогам (ADR-0062) в воркере, а тем нужно только чтение.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

type BackupKind = 'daily' | 'manual' | 'update' | 'before-restore';

export interface BackupItem {
  /** «вид/имя файла» — тем же словом называется копия в заявке службе. */
  readonly id: string;
  readonly kind: BackupKind;
  readonly name: string;
  readonly size: number;
  readonly created_at: string;
  /** Итог последней проверки (разворот во временной базе); `null` — не проверялась. */
  readonly check: { at: string; ok: boolean; detail: string } | null;
}

export interface BackupListing {
  /** Служба хотя бы раз записала список: до этого показывать нечего. */
  readonly available: boolean;
  readonly generated_at: string | null;
  readonly items: readonly BackupItem[];
  /** Когда и кем копию последний раз скачивали; `null` — никогда. */
  readonly last_export: { at: string; by: string; id: string } | null;
}

const KINDS: readonly BackupKind[] = ['daily', 'manual', 'update', 'before-restore'];
const EMPTY: BackupListing = { available: false, generated_at: null, items: [], last_export: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

@Injectable()
export class BackupStatusService {
  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}

  async listing(): Promise<BackupListing> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(this.config.UPDATER_DIR, 'backups.json'), 'utf8'));
    } catch (error) {
      // Нет файла или он повреждён — «служба ещё не писала», а не отказ раздела.
      if (
        (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        error instanceof SyntaxError
      ) {
        return EMPTY;
      }
      throw error;
    }
    if (!isRecord(raw) || !Array.isArray(raw['items'])) return EMPTY;

    const items = (raw['items'] as unknown[]).flatMap((entry): BackupItem[] => {
      if (!isRecord(entry)) return [];
      const { id, kind, name, size, created_at: createdAt, check } = entry;
      if (
        typeof id !== 'string' ||
        typeof name !== 'string' ||
        typeof createdAt !== 'string' ||
        typeof size !== 'number' ||
        !KINDS.includes(kind as BackupKind)
      ) {
        return [];
      }
      return [
        {
          id,
          kind: kind as BackupKind,
          name,
          size,
          created_at: createdAt,
          check:
            isRecord(check) && typeof check['at'] === 'string' && typeof check['ok'] === 'boolean'
              ? {
                  at: check['at'],
                  ok: check['ok'],
                  detail: typeof check['detail'] === 'string' ? check['detail'] : '',
                }
              : null,
        },
      ];
    });
    const last = raw['last_export'];
    return {
      available: true,
      generated_at: typeof raw['generated_at'] === 'string' ? raw['generated_at'] : null,
      items,
      last_export:
        isRecord(last) && typeof last['at'] === 'string'
          ? {
              at: last['at'],
              by: typeof last['by'] === 'string' ? last['by'] : '',
              id: typeof last['id'] === 'string' ? last['id'] : '',
            }
          : null,
    };
  }
}
