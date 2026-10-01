'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { csvName, EXPORT_ROWS_MAX, saveCsv, toCsv } from '@/lib/csv';

type Cell = string | number | null | undefined;

export interface ExportTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  /** В отборе строк больше, чем выгружено. */
  readonly truncated?: boolean;
}

/**
 * «Скачать CSV» ([ADR-0061](../../../../docs/adr/0061-vygruzka-csv.md)): собирает таблицу
 * тем, что отдаёт `load`, и отдаёт файл. Усечённая выгрузка не молчит.
 */
export function ExportButton({
  name,
  load,
}: {
  /** Основа имени файла: `вызовы` → `вызовы-2026-10-01.csv`. */
  name: string;
  load: () => Promise<ExportTable>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'warn' | 'crit'; text: string } | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const table = await load();
      saveCsv(csvName(name), toCsv(table.header, table.rows));
      if (table.truncated === true) {
        setNote({
          tone: 'warn',
          text: `Выгружено ${String(EXPORT_ROWS_MAX)} строк, в отборе их больше. Сузьте период.`,
        });
      }
    } catch (cause) {
      setNote({
        tone: 'crit',
        text: cause instanceof ApiError ? cause.message : 'Не удалось собрать файл',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void run();
        }}
      >
        {busy ? 'Собираем…' : 'Скачать таблицу'}
      </Button>
      {note !== null && (
        <span
          role={note.tone === 'crit' ? 'alert' : 'status'}
          className={note.tone === 'crit' ? 'text-crit' : 'text-warn'}
        >
          {note.text}
        </span>
      )}
    </span>
  );
}
