'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { useUrlState } from '@/lib/url-state';
import { useSession } from '@/lib/session';
import { SettingField, labelOf, type DraftValue, type SettingView } from './setting-field';

const SETTINGS_QUERY_KEY = ['settings'] as const;

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

  const groups = [
    { title: 'Почта', prefixes: ['mail.'] },
    { title: 'Проверка «я не робот»', prefixes: ['captcha.'] },
    { title: 'Регистрация', prefixes: ['partners.'] },
    { title: 'Регистрация клиентов', prefixes: ['clients.'] },
    { title: 'Письма о событиях', prefixes: ['notifications.'] },
    { title: 'Пополнение счёта', prefixes: ['payments.'] },
    { title: 'Хранение', prefixes: ['retention.'] },
    { title: 'Записи разговоров', prefixes: ['recordings.'] },
    { title: 'Сообщения MAX', prefixes: ['messaging.', 'messages.'] },
    { title: 'Узлы', prefixes: ['nodes.'] },
    { title: 'Вход', prefixes: ['security.'] },
    { title: 'Цены партнёров', prefixes: ['pricing.'] },
    { title: 'Кабинеты', prefixes: ['cabinets.'] },
  ];
  const known = new Set(groups.flatMap((group) => group.prefixes));
  const rest = settings.data.settings.filter(
    (setting) => ![...known].some((prefix) => setting.key.startsWith(prefix)),
  );

  const changed = Object.keys(draft);
  const sections = [
    ...groups.map((group) => ({
      key: (group.prefixes[0] ?? '').replace('.', ''),
      title: group.title,
      settings: settings.data.settings.filter((setting) =>
        group.prefixes.some((prefix) => setting.key.startsWith(prefix)),
      ),
      prefix: group.prefixes[0] ?? '',
    })),
    ...(rest.length > 0 ? [{ key: 'other', title: 'Прочее', settings: rest, prefix: '' }] : []),
  ];
  const section = sections.find((candidate) => candidate.key === url.get('section')) ?? sections[0];
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
  const field = (setting: SettingView) => (
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
            <div className="divide-y divide-border-soft">{section.settings.map(field)}</div>
            {section.prefix === 'mail.' && <TestLetter />}
            {section.prefix === 'captcha.' && <CaptchaWarning />}
            {section.prefix === 'messaging.' && <TestProviderKey />}
          </section>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-background py-3">
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

/**
 * Проверка партнёрского ключа провайдера сообщений: ключ принят или нет и сколько аккаунтов заведено.
 * Проверяется сохранённое, а не набранное в полях, как и пробное письмо.
 */
function TestProviderKey() {
  const check = useMutation({
    mutationFn: () =>
      request<{ ok: boolean; message: string }>('/messenger/provider/test', { method: 'POST' }),
  });
  const failure = asApiError(check.error);

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-3">
      <div>
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
      </div>
      {check.data?.ok === true && <p className="text-ok">{check.data.message}</p>}
      {check.data?.ok === false && (
        <p role="alert" className="text-crit">
          {check.data.message}
        </p>
      )}
      {failure !== undefined && <ErrorNote error={failure} />}
    </div>
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
