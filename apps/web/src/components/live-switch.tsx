'use client';

import { LIVE_OPTIONS, setLiveSeconds, useLiveSeconds } from '@/lib/live';

/** «Обновлять» — выбор, как часто страница сама перечитывает данные (`lib/live.ts`). */
export function LiveSwitch() {
  const seconds = useLiveSeconds();
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
