'use client';

/**
 * Переключатель из нескольких вариантов, один выбран: период, «Всё / Звонки / Сообщения»,
 * показатель графика. Один на все экраны — раньше каждый экран держал свою копию классов.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  /** Название группы для чтения с экрана. */
  label: string;
  options: readonly { readonly key: T; readonly label: string }[];
  /** `null` — ни один не выбран (например, выбран свой период в календаре). */
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={value === option.key}
          onClick={() => {
            onChange(option.key);
          }}
          className={`rounded px-2.5 py-1 transition-colors ${value === option.key ? 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
