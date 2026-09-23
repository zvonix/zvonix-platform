'use client';

import { useState, type ReactNode } from 'react';
import { DialogForm, FormDialog } from '@/components/form-dialog';

export interface StatusOption<T extends string> {
  readonly value: T;
  /** Действие, а не состояние: «Заблокировать», а не «Заблокирована». */
  readonly action: string;
  /** Что случится — показывается под вариантами, как только его выбрали. */
  readonly meaning: ReactNode;
  /** Выводит из работы или необратимо: кнопка подтверждения красная. */
  readonly danger?: boolean;
}

/**
 * Смена состояния — одна кнопка в строке и окно с вариантами
 * ([prototype/cabinets](../../../../docs/prototype/cabinets/README.md), «Партнёры»).
 *
 * До него у каждой SIM и шлюза стояло по четыре кнопки переходов, и таблица превращалась
 * в стену кнопок. Окно же и есть подтверждение: последствие выбранного перехода видно
 * до нажатия, а кнопка называет действие. Второе окно поверх не нужно.
 */
export function StatusDialog<T extends string>({
  subject,
  current,
  options,
  onChange,
  disabled = false,
}: {
  /** Чьё состояние: «SIM 79161000001», «шлюз «GOIP в гараже»». */
  subject: string;
  /** Название текущего состояния. */
  current: string;
  options: readonly StatusOption<T>[];
  onChange: (value: T) => Promise<unknown>;
  disabled?: boolean;
}) {
  return (
    <FormDialog
      label="Состояние"
      title={`Состояние: ${subject}`}
      description={`Сейчас — «${current}»`}
      variant="outline"
      disabled={disabled || options.length === 0}
    >
      <StatusChoice options={options} onChange={onChange} />
    </FormDialog>
  );
}

function StatusChoice<T extends string>({
  options,
  onChange,
}: {
  options: readonly StatusOption<T>[];
  onChange: (value: T) => Promise<unknown>;
}) {
  const [chosen, setChosen] = useState<StatusOption<T> | undefined>(undefined);

  return (
    <DialogForm
      submitLabel={chosen?.action ?? 'Выберите состояние'}
      canSubmit={chosen !== undefined}
      tone={chosen?.danger === true ? 'danger' : 'default'}
      onSubmit={() => (chosen === undefined ? Promise.resolve() : onChange(chosen.value))}
    >
      <fieldset className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
        <legend className="pb-1.5 font-medium">Новое состояние</legend>
        {options.map((option) => {
          const pressed = chosen?.value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => {
                setChosen(option);
              }}
              className={`rounded-md border px-3 py-2 text-left font-medium focus-visible:outline-2 focus-visible:outline-ring ${
                pressed ? 'border-primary bg-accent' : 'border-border hover:bg-muted'
              }`}
            >
              {option.action}
            </button>
          );
        })}
      </fieldset>

      {chosen !== undefined && (
        <div
          role="status"
          className={`rounded-md px-3 py-2 sm:col-span-2 ${
            chosen.danger === true ? 'bg-crit-soft text-crit' : 'bg-muted'
          }`}
        >
          {chosen.meaning}
        </div>
      )}
    </DialogForm>
  );
}
