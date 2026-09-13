'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

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
  'mail.test_recipient': 'Адрес для пробного письма',
  'captcha.site_key': 'Ключ страницы',
  'captcha.server_key': 'Серверный ключ',
  'captcha.on_register': 'При регистрации',
  'captcha.on_login': 'При входе',
  'captcha.on_password_reset': 'При восстановлении пароля',
};

export function labelOf(key: string): string {
  return LABELS[key] ?? key;
}

export function SettingField({
  setting,
  draft,
  onChange,
}: {
  setting: SettingView;
  draft: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
}) {
  const id = `setting-${setting.key}`;
  const label = labelOf(setting.key);
  const touched = draft !== undefined;

  if (setting.kind === 'boolean') {
    const checked = touched ? draft === true : setting.value === true;
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

  const stored = setting.value === null ? '' : String(setting.value);
  const shown = touched ? String(draft) : stored;

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-baseline gap-2">
        <Label htmlFor={id}>{label}</Label>
        {setting.secret && <SecretState setting={setting} draft={draft} />}
      </div>
      <Input
        id={id}
        type={setting.secret ? 'password' : setting.kind === 'number' ? 'number' : 'text'}
        autoComplete={setting.secret ? 'new-password' : 'off'}
        className={setting.kind === 'number' ? 'num max-w-[120px]' : undefined}
        value={shown}
        placeholder={setting.secret && setting.is_set ? '•'.repeat(12) : undefined}
        onChange={(event) => {
          const next = event.target.value;
          if (setting.kind === 'number') {
            onChange(next === '' ? '' : Number(next));
            return;
          }
          onChange(next === stored && !setting.secret ? undefined : next);
        }}
      />
      <p className="text-muted-foreground">{setting.hint}</p>
    </div>
  );
}

/**
 * Состояние секрета.
 *
 * Значение секрета обратно не читается ни администратором, ни кем-либо ещё —
 * в базе он лежит шифротекстом (ADR-0031). Поэтому вместо значения показывается,
 * задан он или нет, и что произойдёт с пустым полем.
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
