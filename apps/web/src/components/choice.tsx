'use client';

/**
 * Выбор из закрытого списка с пунктом «любое».
 *
 * Родной `<select>`, а не компонент библиотеки: это не изобретение своей замены,
 * а элемент платформы — на телефоне он открывается родным списком, а с клавиатуры
 * работает без единой строки кода. Компонент библиотеки понадобится там, где нужен
 * поиск по вариантам или своя разметка пункта.
 */
export function Choice({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-9 rounded-md border border-input bg-transparent px-2"
      >
        <option value="">{anyLabel}</option>
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
