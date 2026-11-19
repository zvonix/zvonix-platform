'use client';

import { LIVE_OPTIONS, setLiveSeconds, useLiveSeconds } from '@/lib/live';

/**
 * «Обновлять» — выбор, как часто страница сама перечитывает данные (`lib/live.ts`).
 *
 * `pageDefault` — то же значение страницы, что у её `useLiveInterval`: иначе переключатель показывал бы «выкл»,
 * пока страница обновляется.
 */
export function LiveSwitch({ pageDefault = 0 }: { pageDefault?: number }) {
  const seconds = useLiveSeconds(pageDefault);
  return (
    <label className="flex items-center gap-2">
      <span className="text-muted-foreground">Обновлять</span>
      <select
        value={seconds}
        onChange={(event) => {
          setLiveSeconds(Number(event.target.value));
        }}
        className="h-8 rounded-md border border-input bg-transparent px-2"
      >
        {LIVE_OPTIONS.map((option) => (
          <option key={option.seconds} value={option.seconds}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
