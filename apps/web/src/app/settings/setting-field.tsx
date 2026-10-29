'use client';

import { useState, type ReactNode } from 'react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { integerFromInput, moneyFromInput } from '@/lib/money';

export interface SettingView {
  readonly key: string;
  readonly kind: string;
  readonly hint: string;
  readonly secret: boolean;
  readonly value: string | number | boolean | null;
  readonly is_set: boolean;
  readonly updated_at: string | null;
  readonly min: number | null;
  readonly max: number | null;
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
  'notifications.support_staff_enabled': 'Писать сотрудникам о новых обращениях в поддержку',
  'messaging.enabled': 'Продукт «Сообщения MAX» включён',
  'messaging.provider_partner_url': 'Адрес партнёрского доступа провайдера',
  'messaging.provider_partner_token': 'Ключ партнёрского доступа провайдера',
  'bot.enabled': 'Бот MAX (второй канал сообщений)',
  'bot.message_price': 'Цена сообщения бота для клиента, ₽',
  'bot.monthly_fee': 'Плата клиента за бота в месяц, ₽',
  'bot.own_message_price': 'Цена сообщения со своего бота клиента, ₽',
  'bot.own_monthly_fee': 'Плата клиента за своего бота в месяц, ₽',
  'bot.share_button': 'Надпись кнопки «поделиться номером» в боте',
  'bot.block_stops_accounts': 'Остановил бота — не писать и через аккаунты партнёров',
  'bot.api_url': 'Адрес API ботов MAX',
  'support.autoclose_days': 'Закрыть, если после ответа поддержки клиент молчит, суток',
  'messages.pace_seconds': 'Пауза между сообщениями аккаунта, секунд',
  'messages.recommended_pace_seconds': 'Пауза между сообщениями, секунд',
  'messages.recommended_per_minute': 'Сообщений в минуту, не больше',
  'messages.recommended_per_hour': 'Сообщений в час, не больше',
  'messages.recommended_per_day': 'Сообщений в сутки, не больше',
  'messages.duplicate_window_minutes':
    'Не принимать одинаковое сообщение одному номеру чаще, минут',
  'messages.recipient_limit_per_hour': 'Сообщений одному номеру от клиента в час, не больше',
  'messages.recipient_limit_per_day': 'Сообщений одному номеру от клиента в сутки, не больше',
  'messages.precheck_enabled': 'Проверять наличие MAX у номера перед отправкой',
  'messages.precheck_exists_days': 'Помнить «у номера есть MAX», суток',
  'messages.precheck_absent_days': 'Помнить «у номера нет MAX», суток',
  'messages.dormant_after': 'Пауза номеру после стольких непрочитанных подряд',
  'messages.dormant_pause_1_days': 'Первая пауза, суток',
  'messages.dormant_pause_2_days': 'Вторая пауза, суток',
  'messages.dormant_pause_3_days': 'Третья и дальше, суток',
  'messages.accounts_per_partner_max': 'Аккаунтов MAX у одного партнёра, не больше',
  'messages.health_enabled': 'Ставить на паузу аккаунт, у которого много «нет MAX» после отправки',
  'messages.health_min_sample': 'Здоровье аккаунта: сообщений за сутки для оценки',
  'messages.health_max_absent_percent': 'Здоровье аккаунта: доля «нет MAX» для паузы, %',
  'messages.health_pause_hours': 'Здоровье аккаунта: пауза, часов',
  'messages.max_wait_minutes': 'Сколько сообщение ждёт отправки, минут',
  'retention.messages_days': 'Срок хранения текста сообщений, суток',
  'nodes.auto_update': 'Узлы обновляются сами',
  'security.admin_second_factor_required': 'Второй фактор обязателен администраторам',
  'notifications.payment_decision_enabled': 'Писать клиенту о решении по заявке на пополнение',
  'notifications.partner_suspension_enabled':
    'Писать партнёру о его SIM и шлюзах: отключились или почти не соединяют',
  'recordings.record_all': 'Записывать разговоры по всем линиям',
  'retention.recordings_days': 'Срок хранения записей, суток',
  'retention.metrics_days': 'Срок хранения истории нагрузки, суток',
  'payments.manual_instructions': 'Реквизиты для пополнения переводом',
  'pricing.price_bands_enabled': 'Проверять коридоры цен',
  'calls.warmup_enabled': 'Прогревать новые номера',
  'calls.recommended_per_hour': 'Попыток в час на номер, не больше',
  'calls.recommended_per_day': 'Попыток в сутки на номер, не больше',
  'cabinets.partner_may_add_client': 'Партнёр может стать клиентом',
  'cabinets.client_may_add_partner': 'Клиент может стать партнёром',
  'site.company_name': 'Название компании',
  'site.contact_email': 'Почта для связи',
  'site.contact_phone': 'Телефон',
  'site.contact_telegram': 'Telegram',
  'site.working_hours': 'График работы',
};

/** Суммы в рублях: принимают копейки, остальные числа — только целые. */
const MONEY_KEYS: ReadonlySet<string> = new Set([
  'bot.message_price',
  'bot.monthly_fee',
  'bot.own_message_price',
  'bot.own_monthly_fee',
  'notifications.low_balance_amount',
]);

export function labelOf(key: string): string {
  return LABELS[key] ?? key;
}

/** Подпись поля и значок «?» с пояснением: длинный текст не стоит под каждым полем. */
function FieldLabel({ id, label, hint }: { id: string; label: string; hint: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Label htmlFor={id}>{label}</Label>
      {hint !== '' && (
        <Hint label="Пояснение">
          <p>{hint}</p>
        </Hint>
      )}
    </span>
  );
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
  inlineAction,
  below,
}: {
  setting: SettingView;
  draft: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  /** Годится ли набранное: негодное значение не уходит в черновик и держит сохранение. */
  onValidity: (valid: boolean) => void;
  /** Только у секрета: кнопка в одной строке с полем (например, «Проверить ключ»). */
  inlineAction?: ReactNode;
  /** Только у секрета: что показать под полем — например, ответ на проверку. */
  below?: ReactNode;
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
          <span className="inline-flex items-center gap-1">
            <Label htmlFor={id} className="font-normal">
              {label}
            </Label>
            {setting.hint !== '' && (
              <Hint label="Пояснение">
                <p>{setting.hint}</p>
              </Hint>
            )}
          </span>
        </div>
      </div>
    );
  }

  if (setting.secret) {
    return (
      <SecretField
        id={id}
        label={label}
        setting={setting}
        draft={draft}
        onChange={onChange}
        inlineAction={inlineAction}
        below={below}
      />
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
      <FieldLabel id={id} label={label} hint={setting.hint} />
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
  inlineAction,
  below,
}: {
  id: string;
  label: string;
  setting: SettingView;
  draft: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  inlineAction?: ReactNode;
  below?: ReactNode;
}) {
  const clearing = draft === '';

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <FieldLabel id={id} label={label} hint={setting.hint} />
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
      <div className="flex items-center gap-2">
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
        {inlineAction}
      </div>
      {below}
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
  const money = MONEY_KEYS.has(setting.key);
  const stored = setting.value === null ? '' : String(setting.value);
  // Рубли показываются с запятой, как в остальном кабинете; в API уходит число.
  const shownStored = money ? stored.replace('.', ',') : stored;
  const [raw, setRaw] = useState(shownStored);
  const parse = (text: string): number | undefined => {
    if (!money) return integerFromInput(text);
    const amount = moneyFromInput(text);
    return amount === undefined ? undefined : Number(amount);
  };
  const parsedRaw = parse(raw);
  const notNumber = raw !== shownStored && parsedRaw === undefined;
  const outOfRange =
    parsedRaw !== undefined &&
    ((setting.min !== null && parsedRaw < setting.min) ||
      (setting.max !== null && parsedRaw > setting.max));
  const range =
    setting.min !== null && setting.max !== null
      ? `от ${String(setting.min)} до ${String(setting.max)}`
      : setting.min !== null
        ? `от ${String(setting.min)}`
        : setting.max !== null
          ? `до ${String(setting.max)}`
          : '';

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <FieldLabel id={id} label={label} hint={setting.hint} />
      <div className="flex items-center gap-2">
        <Input
          id={id}
          className="num max-w-[120px]"
          inputMode={money ? 'decimal' : 'numeric'}
          autoComplete="off"
          aria-invalid={notNumber || outOfRange}
          value={raw}
          onChange={(event) => {
            const next = event.target.value;
            setRaw(next);
            const parsed = parse(next);
            const inRange =
              parsed !== undefined &&
              (setting.min === null || parsed >= setting.min) &&
              (setting.max === null || parsed <= setting.max);
            onValidity(inRange || next === shownStored);
            onChange(!inRange || String(parsed) === stored ? undefined : parsed);
          }}
        />
        {range !== '' && <span className="text-muted-foreground">{range}</span>}
      </div>
      {notNumber && (
        <p className="text-warn">
          {money
            ? 'Нужна сумма в рублях, например 0,25.'
            : 'Нужно целое число — без знаков и дробной части.'}
        </p>
      )}
      {outOfRange && <p className="text-warn">Допустимо {range}.</p>}
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
