'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { useUrlState } from '@/lib/url-state';
import { useSession } from '@/lib/session';
import { CertificatePanel } from './certificate-panel';
import { GithubTokenPanel } from './github-token-panel';
import { SettingField, labelOf, type DraftValue, type SettingView } from './setting-field';

const SETTINGS_QUERY_KEY = ['settings'] as const;

/**
 * Подзаголовки внутри раздела: у раздела на десяток полей без них не видно, что к чему относится.
 * Настройка без подзаголовка идёт первой, без заголовка; порядок полей — как у площадки.
 */
const SUBGROUPS: Record<string, string> = {
  'captcha.site_key': 'Ключи SmartCaptcha',
  'captcha.server_key': 'Ключи SmartCaptcha',
  'captcha.on_register': 'Где проверять',
  'captcha.on_login': 'Где проверять',
  'captcha.on_password_reset': 'Где проверять',
  'notifications.low_balance_enabled': 'Клиенту',
  'notifications.low_balance_amount': 'Клиенту',
  'notifications.payment_decision_enabled': 'Клиенту',
  'notifications.partner_suspension_enabled': 'Партнёру',
  'notifications.alerts_enabled': 'Администраторам',
  'notifications.support_staff_enabled': 'Администраторам',
  'calls.warmup_enabled': 'Прогрев',
  'calls.recommended_per_hour': 'Рекомендованная работа номера',
  'calls.recommended_per_day': 'Рекомендованная работа номера',
  'calls.pause_seconds': 'Ровный темп',
  'calls.warmup_pause_seconds': 'Ровный темп',
  'calls.distinct_per_hour': 'Разные абоненты',
  'calls.distinct_per_day': 'Разные абоненты',
  'calls.sleep_hours': 'Сон и ответы',
  'calls.poor_answer_percent': 'Сон и ответы',
  'calls.recipient_per_hour': 'Звонки одному абоненту',
  'calls.recipient_per_day': 'Звонки одному абоненту',
  'messaging.enabled': 'Продукт',
  'messaging.provider_partner_url': 'Провайдер',
  'messaging.provider_partner_token': 'Провайдер',
  'messages.pace_seconds': 'Отправка',
  'messages.max_wait_minutes': 'Отправка',
  'messages.recommended_pace_seconds': 'Рекомендованная работа аккаунта',
  'messages.sleep_hours': 'Рекомендованная работа аккаунта',
  'messages.recommended_per_minute': 'Рекомендованная работа аккаунта',
  'messages.recommended_per_hour': 'Рекомендованная работа аккаунта',
  'messages.recommended_per_day': 'Рекомендованная работа аккаунта',
  'messages.duplicate_window_minutes': 'Отправка',
  'messages.recipient_limit_per_hour': 'Отправка',
  'messages.recipient_limit_per_day': 'Отправка',
  'messages.precheck_enabled': 'Проверка номера перед отправкой',
  'messages.precheck_exists_days': 'Проверка номера перед отправкой',
  'messages.precheck_absent_days': 'Проверка номера перед отправкой',
  'messages.dormant_after': 'Молчащие получатели',
  'messages.dormant_pause_1_days': 'Молчащие получатели',
  'messages.dormant_pause_2_days': 'Молчащие получатели',
  'messages.dormant_pause_3_days': 'Молчащие получатели',
  'messages.accounts_per_partner_max': 'Аккаунты партнёров',
  'messages.health_enabled': 'Здоровье аккаунта',
  'messages.health_min_sample': 'Здоровье аккаунта',
  'messages.health_max_absent_percent': 'Здоровье аккаунта',
  'messages.health_pause_hours': 'Здоровье аккаунта',
  'bot.enabled': 'Включение',
  'bot.api_url': 'Включение',
  'bot.share_button': 'Подписчики',
  'bot.block_stops_accounts': 'Подписчики',
  'bot.message_price': 'Цены для клиента',
  'bot.monthly_fee': 'Цены для клиента',
  'bot.own_message_price': 'Цены для клиента',
  'bot.own_monthly_fee': 'Цены для клиента',
};

/** Делит настройки раздела на подгруппы в порядке первого появления. */
function subgroupsOf(
  settings: readonly SettingView[],
): { title: string | undefined; items: SettingView[] }[] {
  const groups: { title: string | undefined; items: SettingView[] }[] = [];
  for (const setting of settings) {
    const title = SUBGROUPS[setting.key];
    const existing = groups.find((group) => group.title === title);
    if (existing === undefined) groups.push({ title, items: [setting] });
    else existing.items.push(setting);
  }
  // Без заголовка — всегда первой: общие поля раздела идут выше его подгрупп.
  return groups.sort((a, b) => Number(b.title === undefined) - Number(a.title === undefined));
}

/**
 * Разделы настроек. Раньше их было семнадцать, многие — из одной-двух настроек; теперь по смыслу, а части внутри
 * раздела (`parts`) отделены заголовками. Ключ раздела — в адресе (`?section=`).
 */
const SECTIONS: readonly {
  key: string;
  title: string;
  parts: readonly { title: string; prefixes: readonly string[] }[];
}[] = [
  {
    key: 'registration',
    title: 'Участники',
    parts: [
      { title: 'Регистрация партнёров', prefixes: ['partners.'] },
      { title: 'Регистрация клиентов', prefixes: ['clients.'] },
      { title: 'Кабинеты', prefixes: ['cabinets.'] },
    ],
  },
  // Своим разделом: к участникам и их регистрации обращения не относятся (владелец, 2026-10-22).
  {
    key: 'support',
    title: 'Поддержка',
    parts: [{ title: 'Обращения', prefixes: ['support.'] }],
  },
  {
    key: 'calls',
    title: 'Звонки',
    parts: [
      { title: 'Номера SIM и SIP-провайдеров', prefixes: ['calls.'] },
      { title: 'Узлы', prefixes: ['nodes.'] },
      { title: 'Записи разговоров', prefixes: ['recordings.'] },
    ],
  },
  {
    key: 'mail',
    title: 'Почта и письма',
    parts: [
      { title: 'Почта', prefixes: ['mail.'] },
      { title: 'Письма о событиях', prefixes: ['notifications.'] },
    ],
  },
  {
    key: 'messaging',
    title: 'Сообщения MAX',
    parts: [
      { title: 'Через аккаунты партнёров', prefixes: ['messaging.', 'messages.'] },
      { title: 'Бот площадки', prefixes: ['bot.'] },
    ],
  },
  {
    key: 'money',
    title: 'Деньги',
    parts: [
      { title: 'Пополнение счёта', prefixes: ['payments.'] },
      { title: 'Цены партнёров', prefixes: ['pricing.'] },
    ],
  },
  {
    key: 'security',
    title: 'Безопасность',
    parts: [
      { title: 'Вход', prefixes: ['security.'] },
      { title: 'Проверка «я не робот»', prefixes: ['captcha.'] },
    ],
  },
  {
    key: 'system',
    title: 'Система',
    parts: [
      { title: 'Хранение', prefixes: ['retention.'] },
      { title: 'Сайт', prefixes: ['site.'] },
    ],
  },
];

/** Старые ключи разделов → новые. */
const SECTION_ALIASES: Record<string, string> = {
  captcha: 'security',
  partners: 'registration',
  clients: 'registration',
  cabinets: 'registration',
  notifications: 'mail',
  bot: 'messaging',
  payments: 'money',
  pricing: 'money',
  nodes: 'calls',
  retention: 'system',
  recordings: 'calls',
  site: 'system',
};

interface SettingsResponse {
  readonly settings: SettingView[];
}

interface TestResult {
  readonly delivered: boolean;
  readonly error: string | null;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

export default function SettingsPage() {
  return (
    <ConsoleShell title="Настройки площадки" requireRole="admin">
      {() => <SettingsForm />}
    </ConsoleShell>
  );
}

function SettingsForm() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const url = useUrlState();

  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => request<SettingsResponse>('/settings'),
  });

  const saving = {
    mutationFn: (changes: Record<string, DraftValue>) =>
      request<SettingsResponse>('/settings', { method: 'PUT', body: { settings: changes } }),
    onSuccess: (response: SettingsResponse) => {
      // Ответ содержит новый список целиком — кладём его в кэш вместо повторного
      // запроса: лишнее обращение только даёт странице мигнуть.
      queryClient.setQueryData(SETTINGS_QUERY_KEY, response);
      setDraft({});
      setInvalid(new Set());
      setSavedAt(new Date().toISOString());
    },
  };
  const save = useMutation(saving);
  // Сохранение с очисткой секрета идёт через подтверждение, и отказ показывается в окне.
  // Общая мутация показала бы его второй раз в нижней панели.
  const confirmSave = useMutation(saving);

  function change(key: string, value: DraftValue | undefined): void {
    setDraft((previous) => {
      // Значение вернулось к сохранённому — ключ уходит из черновика целиком,
      // иначе «не сохранено» показывало бы поля, в которых ничего не изменилось.
      if (value === undefined) {
        const { [key]: _removed, ...rest } = previous;
        return rest;
      }
      return { ...previous, [key]: value };
    });
  }

  function validity(key: string, valid: boolean): void {
    setInvalid((previous) => {
      const next = new Set(previous);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (settings.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const loadError = asApiError(settings.error);
  if (loadError !== undefined) return <ErrorNote error={loadError} />;
  if (settings.data === undefined) return null;

  const settingsOf = (prefixes: readonly string[]): SettingView[] =>
    settings.data.settings.filter((setting) =>
      prefixes.some((prefix) => setting.key.startsWith(prefix)),
    );
  const known = new Set(SECTIONS.flatMap((item) => item.parts.flatMap((part) => part.prefixes)));
  const rest = settings.data.settings.filter(
    (setting) => ![...known].some((prefix) => setting.key.startsWith(prefix)),
  );

  const changed = Object.keys(draft);
  const sections = [
    ...SECTIONS.map((item) => {
      const parts = item.parts.map((part) => ({
        title: part.title,
        settings: settingsOf(part.prefixes),
      }));
      return {
        key: item.key,
        title: item.title,
        parts,
        settings: parts.flatMap((part) => part.settings),
        prefix: item.parts[0]?.prefixes[0] ?? '',
      };
    }),
    // Сертификат — не настройка из списка, а состояние сервера с действиями (ADR-0083).
    { key: 'certificate', title: 'Сертификат', parts: [], settings: [], prefix: 'certificate' },
    // Токен GitHub для обновлений — тоже состояние сервера, а не настройка из списка (ADR-0084).
    { key: 'updates', title: 'Обновления', parts: [], settings: [], prefix: 'updates' },
    ...(rest.length > 0
      ? [
          {
            key: 'other',
            title: 'Прочее',
            parts: [{ title: 'Прочее', settings: rest }],
            settings: rest,
            prefix: '',
          },
        ]
      : []),
  ];
  // Прежние адреса разделов (до объединения) ведут в новые: ссылки из писем и закладок не ломаются.
  const wanted = url.get('section');
  const requested = SECTION_ALIASES[wanted] ?? wanted;
  const section = sections.find((candidate) => candidate.key === requested) ?? sections[0];
  const unsaved = (keys: readonly string[]): number =>
    changed.filter((key) => keys.includes(key)).length;
  const secrets = new Set(
    settings.data.settings.filter((setting) => setting.secret).map((setting) => setting.key),
  );
  const cleared = changed.filter((key) => secrets.has(key) && draft[key] === '');
  const error = asApiError(save.error);
  const blocked = changed.length === 0 || invalid.size > 0;

  // Поле пересоздаётся после сохранения: у числового поля свой набранный текст,
  // и без этого он пережил бы смену сохранённого значения.
  const field = (setting: SettingView) =>
    setting.key === 'messaging.provider_partner_token' ? (
      <ProviderKeyField
        key={`${setting.key}:${setting.updated_at ?? ''}`}
        setting={setting}
        draft={draft[setting.key]}
        onChange={(value) => {
          change(setting.key, value);
        }}
        onValidity={(valid) => {
          validity(setting.key, valid);
        }}
      />
    ) : (
      <SettingField
        key={`${setting.key}:${setting.updated_at ?? ''}`}
        setting={setting}
        draft={draft[setting.key]}
        onChange={(value) => {
          change(setting.key, value);
        }}
        onValidity={(valid) => {
          validity(setting.key, valid);
        }}
      />
    );

  return (
    <div className="flex max-w-[1100px] flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Разделы: на телефоне — список выбора, на компьютере — колонка слева. Выбранный раздел в адресе. */}
        <label className="flex flex-col gap-1 lg:hidden">
          <span className="text-muted-foreground">Раздел</span>
          <select
            value={section?.key}
            onChange={(event) => {
              url.set({ section: event.target.value });
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2"
          >
            {sections.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <nav
          aria-label="Разделы настроек"
          className="sticky top-4 hidden h-fit flex-col gap-0.5 lg:flex"
        >
          {sections.map((item) => {
            const marks = unsaved(item.settings.map((setting) => setting.key));
            const current = item.key === section?.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  url.set({ section: item.key });
                }}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                  current
                    ? 'bg-muted font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {item.title}
                {marks > 0 && (
                  <span
                    role="img"
                    aria-label={`несохранённых: ${String(marks)}`}
                    className="ml-auto size-2 rounded-full bg-warn"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {section !== undefined && (
          <section className="max-w-[760px] rounded-lg border border-border bg-card p-4">
            <h2 className="pb-2 font-semibold">{section.title}</h2>
            {/* Настройка, для которой ещё нет раздела, живёт в «Прочем»: лучше показать под ключом,
                чем не показать вовсе — иначе новое поле пропадает молча. */}
            {section.key === 'certificate' && <CertificatePanel />}
            {section.key === 'updates' && <GithubTokenPanel />}
            <div className="flex flex-col gap-6">
              {section.parts
                .filter((part) => part.settings.length > 0)
                .map((part) => (
                  <div key={part.title} className="flex flex-col gap-3">
                    {/* Заголовок части — только когда в разделе их несколько: иначе повторял бы название раздела. */}
                    {section.parts.length > 1 && (
                      <h3 className="border-b-2 border-border pb-1.5 text-sm font-semibold">
                        {part.title}
                      </h3>
                    )}
                    {subgroupsOf(part.settings).map((group) => (
                      <div
                        key={group.title ?? ''}
                        className="overflow-hidden rounded-md border border-border"
                      >
                        {group.title !== undefined && (
                          <h4 className="border-b border-border bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {group.title}
                          </h4>
                        )}
                        <div className="divide-y divide-border-soft px-3">
                          {group.items.map(field)}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
            {section.prefix === 'mail.' && (
              <>
                <TestLetter />
                <MailQueue />
              </>
            )}
            {section.key === 'security' && <CaptchaWarning />}
          </section>
        )}
      </div>

      {/* -mb-4 уравнивает нижний отступ страницы (p-4): иначе в конце прокрутки панель поднималась на 16 px. */}
      <div className="sticky bottom-0 -mb-4 flex flex-wrap items-center gap-3 border-t border-border bg-background py-3">
        {/*
          Очистка секрета — через подтверждение: без пароля почта перестаёт уходить,
          без серверного ключа капча выключается. Остальное сохраняется сразу.
        */}
        {cleared.length > 0 ? (
          <ConfirmAction
            label={confirmSave.isPending ? 'Сохраняем…' : 'Сохранить'}
            variant="default"
            size="default"
            disabled={blocked || save.isPending || confirmSave.isPending}
            title="Сохранить и очистить секреты"
            consequence={
              <>
                <p>Будут очищены: {cleared.map((key) => labelOf(key)).join(', ')}.</p>
                <p>
                  Без пароля почты письма перестанут уходить, без серверного ключа капча выключится.
                  Вернуть прежнее значение нельзя — его придётся ввести заново.
                </p>
              </>
            }
            confirmLabel="Сохранить и очистить"
            onConfirm={() => {
              save.reset();
              return confirmSave.mutateAsync(draft);
            }}
          />
        ) : (
          <Button
            type="button"
            disabled={blocked || save.isPending}
            onClick={() => {
              save.mutate(draft);
            }}
          >
            {save.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        )}

        {invalid.size > 0 && (
          <span className="text-warn">
            Исправьте: {[...invalid].map((key) => labelOf(key)).join(', ')}
          </span>
        )}

        {changed.length > 0 && invalid.size === 0 && (
          <span className="text-muted-foreground">
            Не сохранено: {changed.map((key) => labelOf(key)).join(', ')}
          </span>
        )}

        {changed.length === 0 && invalid.size === 0 && savedAt !== undefined && (
          <span className="text-ok">
            Сохранено в {moment(savedAt)}. В соседнем процессе подействует в течение полуминуты.
          </span>
        )}

        {error !== undefined && <ErrorNote error={error} />}
      </div>
    </div>
  );
}

/**
 * Пробное письмо.
 *
 * Единственный способ убедиться, что почта работает, не дожидаясь чужого
 * восстановления пароля. Ответ почтового сервера показывается целиком: без него
 * «не работает» неотличимо от «не тот пароль».
 */
function TestLetter() {
  // Проверяющий почти всегда шлёт письмо себе: адрес входа подставлен сразу, его можно
  // заменить. Отдельной настройки «адрес для пробного письма» больше нет — два поля
  // для одного письма путали (владелец, 2026-09-23).
  const own = useSession().data?.email ?? '';
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const recipient = (typed ?? own).trim();

  const send = useMutation({
    mutationFn: () =>
      request<TestResult>('/settings/mail/test', {
        method: 'POST',
        body: { recipient },
        // Письмо идёт наружу, и у соединения с почтовым сервером свои пределы — до 15 с
        // на шаг. Кабинет ждёт дольше них, иначе ответ сервера, ради которого проверка
        // и существует, не доходил бы до экрана.
        timeoutMs: 40_000,
      }),
  });

  const failure = asApiError(send.error);

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-3">
      <p className="text-muted-foreground">
        Пробное письмо идёт мимо очереди и возвращает ответ почтового сервера. Сохраните изменения
        перед отправкой: проверяются сохранённые настройки, а не то, что набрано в полях.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          aria-label="Адрес для пробного письма"
          autoComplete="off"
          spellCheck={false}
          placeholder="name@example.ru"
          className="max-w-[240px]"
          value={typed ?? own}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={send.isPending || recipient === ''}
          onClick={() => {
            send.mutate();
          }}
        >
          {send.isPending ? 'Отправляем…' : 'Отправить пробное'}
        </Button>
      </div>

      {send.data?.delivered === true && <p className="text-ok">Письмо принято сервером.</p>}
      {send.data?.delivered === false && (
        <p role="alert" className="text-crit">
          Сервер отказал: {send.data.error}
        </p>
      )}
      {failure !== undefined && <ErrorNote error={failure} />}
    </div>
  );
}

interface MailQueueView {
  readonly configured: boolean;
  readonly pending: number;
  readonly failed: number;
  readonly sent: number;
  readonly oldest_pending_at: string | null;
  readonly recent: readonly {
    kind: string;
    recipient: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    sent_at: string | null;
  }[];
}

const MAIL_STATUS: Record<string, string> = {
  pending: 'ждёт',
  sent: 'отправлено',
  failed: 'не ушло',
};

/**
 * Очередь писем: письма входа, подтверждения почты и восстановления пароля уходят через неё, а пробное письмо —
 * мимо. Когда пробное доходит, а обычные нет, причина видна здесь: письма не ставятся, ждут воркера или почтовый
 * сервер отказывает (его ответ — в колонке «Причина»).
 */
function MailQueue() {
  const queue = useQuery({
    queryKey: ['settings', 'mail-queue'],
    queryFn: () => request<MailQueueView>('/settings/mail/queue'),
    refetchInterval: 15_000,
  });
  const data = queue.data;
  const failure = asApiError(queue.error);
  // Ждёт давно, а попыток не было — отправляющий процесс не работает.
  const stuck =
    data?.oldest_pending_at != null &&
    Date.now() - new Date(data.oldest_pending_at).getTime() > 3 * 60_000;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-3">
      <h3 className="font-semibold">Очередь писем</h3>
      {failure !== undefined && <ErrorNote error={failure} />}
      {data !== undefined && (
        <>
          <p className="num text-muted-foreground">
            Ждут: {data.pending} · не ушли: {data.failed} · отправлены: {data.sent}
          </p>
          {stuck && (
            <p role="alert" className="text-warn">
              Письмо ждёт больше трёх минут: если в колонке «Попыток» нули, письма не отправляет
              фоновый процесс (воркер); если там ошибка — отказывает почтовый сервер.
            </p>
          )}
          {data.recent.length === 0 ? (
            <p className="text-muted-foreground">
              Очередь пуста: письма входа, подтверждения и восстановления в неё пока не ставились
              (или превышен предел десяти писем в час на один адрес).
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1 font-normal">Когда</th>
                    <th className="px-2 py-1 font-normal">Вид</th>
                    <th className="px-2 py-1 font-normal">Кому</th>
                    <th className="px-2 py-1 font-normal">Состояние</th>
                    <th className="px-2 py-1 text-right font-normal">Попыток</th>
                    <th className="px-2 py-1 font-normal">Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((row) => (
                    <tr
                      key={`${row.created_at}${row.recipient}${row.kind}`}
                      className="border-t border-border-soft"
                    >
                      <td className="num px-2 py-1">{moment(row.created_at)}</td>
                      <td className="px-2 py-1">{row.kind}</td>
                      <td className="num px-2 py-1">{row.recipient}</td>
                      <td className={`px-2 py-1 ${row.status === 'failed' ? 'text-crit' : ''}`}>
                        {MAIL_STATUS[row.status] ?? row.status}
                      </td>
                      <td className="num px-2 py-1 text-right">{row.attempts}</td>
                      <td className="whitespace-normal px-2 py-1 text-muted-foreground">
                        {row.last_error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Поле ключа провайдера сообщений с кнопкой проверки в одной строке: ключ принят или нет и сколько
 * аккаунтов заведено. Проверяется сохранённое, а не набранное в полях, как и пробное письмо.
 */
function ProviderKeyField(props: ComponentProps<typeof SettingField>) {
  const check = useMutation({
    mutationFn: () =>
      request<{ ok: boolean; message: string }>('/messenger/provider/test', { method: 'POST' }),
  });
  const failure = asApiError(check.error);

  return (
    <SettingField
      {...props}
      inlineAction={
        <Button
          type="button"
          variant="outline"
          disabled={check.isPending}
          onClick={() => {
            check.mutate();
          }}
        >
          {check.isPending ? 'Проверяем…' : 'Проверить ключ'}
        </Button>
      }
      below={
        <>
          {check.data?.ok === true && <p className="text-ok">{check.data.message}</p>}
          {check.data?.ok === false && (
            <p role="alert" className="text-crit">
              {check.data.message}
            </p>
          )}
          {failure !== undefined && <ErrorNote error={failure} />}
        </>
      }
    />
  );
}

/** Цена включённой капчи названа прямо: это единственное место, ломающее вход всем. */
function CaptchaWarning() {
  return (
    <p className="mt-3 border-t border-border-soft pt-3 text-muted-foreground">
      Включённая капча без ключей считается выключенной, а недоступность SmartCaptcha не закрывает
      формы: отказ на этом месте закрыл бы вход всем, включая вас. На это время формы защищены
      только пределом частоты по адресу и блокировкой учётной записи.
    </p>
  );
}
