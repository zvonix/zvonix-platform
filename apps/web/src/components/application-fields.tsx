'use client';

import type { Cabinet } from '@zvonix/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { integerFromInput } from '@/lib/money';

/**
 * Анкета заявки на кабинет ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Одна на регистрацию и на заявку второго кабинета из уже открытого: поля и правила
 * те же, и две копии разошлись бы на первой правке. Проверку делает API (схема
 * `identity/schemas.ts`), форма только собирает и показывает его разбор по полям.
 */

/** Сырые значения полей — строками, как их набирает человек. */
export interface ApplicationDraft {
  readonly companyName: string;
  readonly city: string;
  readonly callsPerDay: string;
  readonly region: string;
  readonly simCount: string;
  readonly phone: string;
  readonly operators: readonly string[];
}

export const EMPTY_APPLICATION: ApplicationDraft = {
  companyName: '',
  city: '',
  callsPerDay: '',
  region: '',
  simCount: '',
  phone: '',
  operators: [],
};

/** Операторы, SIM которых бывают у партнёров. Справочник площадки до одобрения закрыт. */
const OPERATORS = ['МТС', 'T2', 'Мегафон', 'Билайн', 'Йота'] as const;

/** Тело заявки для API. Пустое «примерно» не отправляется; негодное число уходит как есть — ответит API. */
export function toApplication(
  cabinet: Cabinet,
  draft: ApplicationDraft,
): { cabinet: Cabinet; answers: Record<string, unknown> } {
  const rough = (value: string): number | string | undefined => {
    if (value.trim() === '') return undefined;
    return integerFromInput(value) ?? value;
  };
  const optional = (key: string, value: number | string | undefined) =>
    value === undefined ? {} : { [key]: value };

  if (cabinet === 'client') {
    return {
      cabinet,
      answers: {
        companyName: draft.companyName,
        city: draft.city,
        phone: draft.phone,
        ...optional('callsPerDay', rough(draft.callsPerDay)),
      },
    };
  }
  return {
    cabinet,
    answers: {
      region: draft.region,
      phone: draft.phone,
      operators: draft.operators,
      ...optional('simCount', rough(draft.simCount)),
    },
  };
}

export function ApplicationFields({
  cabinet,
  value,
  onChange,
}: {
  cabinet: Cabinet;
  value: ApplicationDraft;
  onChange: (next: ApplicationDraft) => void;
}) {
  const set = (key: keyof ApplicationDraft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...value, [key]: event.target.value });
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cabinet === 'client' ? (
        <>
          <Field id="companyName" label="Название службы такси" hint="Так вас увидит администратор">
            <Input
              id="companyName"
              autoComplete="organization"
              required
              value={value.companyName}
              onChange={set('companyName')}
            />
          </Field>
          <Field id="city" label="Город">
            <Input
              id="city"
              autoComplete="address-level2"
              required
              value={value.city}
              onChange={set('city')}
            />
          </Field>
          <Field
            id="callsPerDay"
            label="Звонков в день, примерно"
            hint="Необязательно. Поможет заранее подготовить ёмкость"
          >
            <Input
              id="callsPerDay"
              inputMode="numeric"
              value={value.callsPerDay}
              onChange={set('callsPerDay')}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id="region" label="Регион, где стоят шлюзы">
            <Input
              id="region"
              autoComplete="address-level1"
              required
              value={value.region}
              onChange={set('region')}
            />
          </Field>
          <Field id="simCount" label="Сколько у вас SIM" hint="Необязательно, можно примерно">
            <Input
              id="simCount"
              inputMode="numeric"
              value={value.simCount}
              onChange={set('simCount')}
            />
          </Field>
          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="pb-1.5 text-sm font-medium">Операторы ваших SIM</legend>
            <div className="flex flex-wrap gap-2">
              {OPERATORS.map((operator) => {
                const on = value.operators.includes(operator);
                return (
                  <button
                    key={operator}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      onChange({
                        ...value,
                        operators: on
                          ? value.operators.filter((item) => item !== operator)
                          : [...value.operators, operator],
                      });
                    }}
                    className={
                      on
                        ? 'h-9 rounded-full border border-primary bg-primary/10 px-4 font-medium'
                        : 'h-9 rounded-full border border-border px-4 text-muted-foreground hover:text-foreground'
                    }
                  >
                    {operator}
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-muted-foreground">
              Звонки пойдут только внутри сети каждой SIM — такие звонки у вас бесплатны
            </span>
          </fieldset>
        </>
      )}
      <Field id="phone" label="Телефон" hint="Позвоним, если будут вопросы по заявке">
        <Input
          id="phone"
          type="tel"
          autoComplete="tel"
          required
          value={value.phone}
          onChange={set('phone')}
        />
      </Field>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
