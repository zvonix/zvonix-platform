'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { integerFromInput } from '@/lib/money';

export interface SettingView {
  readonly key: string;
  readonly kind: string;
  readonly hint: string;
  readonly secret: boolean;
  readonly value: string | number | boolean | null;
  readonly is_set: boolean;
  readonly updated_at: string | null;
}

export type DraftValue = string | number | boolean;

/**
 * Названия полей.
 *
 * Список настроек приходит от площадки — он там закрытый (ADR-0031), и второй копии
 * здесь нет. Здесь только человеческие подписи: настройка, для которой подписи ещё
 * не завели, всё равно покажется — под своим ключом. Так новое поле видно сразу,
 * а не пропадает молча.
 */
const LABELS: Record<string, string> = {
  'mail.host': 'Узел SMTP',
  'mail.port': 'Порт',
  'mail.secure': 'Шифрование с первого байта',
  'mail.user': 'Имя для входа',
  'mail.password': 'Пароль',
  'mail.from': 'Отправитель',
  'captcha.site_key': 'Ключ страницы',
  'captcha.server_key': 'Серверный ключ',
  'captcha.on_register': 'При регистрации',
  'captcha.on_login': 'При входе',
  'captcha.on_password_reset': 'При восстановлении пароля',
  'partners.auto_approve': 'Партнёры без проверки администратором',
  'clients.auto_approve': 'Клиенты без проверки администратором',
  'notifications.low_balance_enabled': 'Писать клиенту, когда на счёте мало',
  'notifications.low_balance_amount': 'Порог, ₽',
  'notifications.alerts_enabled':
    'Писать администраторам о неполадках и новых заявках на пополнение',
  'retention.recordings_days': 'Срок хранения записей, суток',
  'retention.metrics_days': 'Срок хранения истории нагрузки, суток',
  'payments.manual_instructions': 'Реквизиты для пополнения переводом',
  'pricing.price_bands_enabled': 'Проверять коридоры цен',
  'cabinets.partner_may_add_client': 'Партнёр может стать клиентом',
  'cabinets.client_may_add_partner': 'Клиент может стать партнёром',
};

export function labelOf(key: string): string {
  return LABELS[key] ?? key;
}

/**
 * Поле настройки.
 *
 * Черновик: `undefined` — «не трогать», значение — «записать». Для секрета пустая строка
 * значит «очистить», и выражается она **только кнопкой**: раньше достаточно было набрать
 * и стереть символ в поле пароля, чтобы сохранение стёрло пароль почты
 * (ui-review, 2026-09-14).
 */
export function SettingField({
  setting,
  draft,
  onChange,
  onValidity,
}: {
  setting: SettingView;
  draft: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  /** Годится ли набранное: негодное значение не уходит в черновик и держит сохранение. */
  onValidity: (valid: boolean) => void;
}) {
  const id = `setting-${setting.key}`;
  const label = labelOf(setting.key);

  if (setting.kind === 'boolean') {
    const checked = draft === undefined ? setting.value === true : draft === true;
    return (
      <div className="flex items-start gap-3 py-1.5">
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={(next) => {
            onChange(next === (setting.value === true) ? undefined : next);
          }}
        />
        <div className="min-w-0">
          <Label htmlFor={id} className="font-normal">
            {label}
          </Label>
          <p className="text-muted-foreground">{setting.hint}</p>
        </div>
      </div>
    );
  }

  if (setting.secret) {
    return (
      <SecretField id={id} label={label} setting={setting} draft={draft} onChange={onChange} />
    );
  }

  if (setting.kind === 'number') {
    return (
      <NumberField
        id={id}
        label={label}
        setting={setting}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  }

  const stored = setting.value === null ? '' : String(setting.value);
  const shown = draft === undefined ? stored : String(draft);

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === stored ? undefined : next);
        }}
      />
      <p className="text-muted-foreground">{setting.hint}</p>
    </div>
  );
}

/**
 * Секрет: пароль почты, серверный ключ капчи.
 *
 * Значение обратно не читается ни администратором, ни кем-либо ещё — в базе он лежит
 * шифротекстом (ADR-0031). Пустое поле всегда значит «не трогать», очистка — отдельной
 * кнопкой. Значение из одних пробелов тоже «не трогать»: площадка обрезает пробелы,
 * и такой «пароль» очистил бы секрет так же, как пустая строка.
 */
function SecretField({
  id,
  label,
  setting,
  draft,
  onChange,
}: {
  id: string;
  label: string;
  setting: SettingView;
  draft: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
}) {
  const clearing = draft === '';

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <Label htmlFor={id}>{label}</Label>
        <SecretState setting={setting} draft={draft} />
        {setting.is_set &&
          (clearing ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                onChange(undefined);
              }}
            >
              Не очищать
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                onChange('');
              }}
            >
              Очистить
            </Button>
          ))}
      </div>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        disabled={clearing}
        value={typeof draft === 'string' ? draft : ''}
        placeholder={setting.is_set ? '•'.repeat(12) : undefined}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next.trim() === '' ? undefined : next);
        }}
      />
      <p className="text-muted-foreground">{setting.hint}</p>
    </div>
  );
}

/**
 * Число: порт почты и подобное.
 *
 * Набранное хранится здесь сырым текстом, а в черновик уходит только разобранное целое.
 * Раньше поле было `type="number"`, пустое значение уходило в API пустой строкой
 * и получало отказ, а черновик не снимался, даже когда число вернули к сохранённому.
 */
function NumberField({
  id,
  label,
  setting,
  onChange,
  onValidity,
}: {
  id: string;
  label: string;
  setting: SettingView;
  onChange: (value: DraftValue | undefined) => void;
  onValidity: (valid: boolean) => void;
}) {
  const stored = setting.value === null ? '' : String(setting.value);
  const [raw, setRaw] = useState(stored);
  const invalid = raw !== stored && integerFromInput(raw) === undefined;

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="num max-w-[120px]"
        inputMode="numeric"
        autoComplete="off"
        value={raw}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          const parsed = integerFromInput(next);
          onValidity(parsed !== undefined || next === stored);
          onChange(parsed === undefined || String(parsed) === stored ? undefined : parsed);
        }}
      />
      {invalid && <p className="text-warn">Нужно целое число — без знаков и дробной части.</p>}
      <p className="text-muted-foreground">{setting.hint}</p>
    </div>
  );
}

/**
 * Состояние секрета.
 *
 * Вместо значения показывается, задан ли он и что произойдёт при сохранении.
 */
function SecretState({ setting, draft }: { setting: SettingView; draft: DraftValue | undefined }) {
  if (draft === '') {
    return <span className="text-crit">будет очищен</span>;
  }
  if (draft !== undefined) {
    return <span className="text-ok">будет заменён</span>;
  }
  return setting.is_set ? (
    <span className="text-muted-foreground">задан — пустое поле его не тронет</span>
  ) : (
    <span className="text-warn">не задан</span>
  );
}
