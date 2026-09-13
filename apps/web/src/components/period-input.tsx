'use client';

/**
 * Граница периода в отборе.
 *
 * Родное поле выбора момента отдаёт время **без пояса**, а API ждёт ISO со смещением:
 * без перевода «с 9:00» означало бы девять утра по Гринвичу, то есть полдень
 * в Екатеринбурге. Перевод в обе стороны — здесь, и только здесь: два экрана
 * со своими копиями этого перевода разошлись бы на первой же правке.
 */
export function PeriodInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="datetime-local"
        value={toLocalInput(value)}
        onChange={(event) => {
          onChange(fromLocalInput(event.target.value));
        }}
        className="num h-9 rounded-md border border-input bg-transparent px-2"
      />
    </label>
  );
}

function toLocalInput(iso: string): string {
  if (iso === '') return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const shifted = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function fromLocalInput(local: string): string {
  if (local === '') return '';
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}
