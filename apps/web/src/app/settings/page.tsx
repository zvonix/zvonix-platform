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
    { title: 'Почта', prefix: 'mail.' },
    { title: 'Проверка «я не робот»', prefix: 'captcha.' },
    { title: 'Партнёры', prefix: 'partners.' },
    { title: 'Цены партнёров', prefix: 'pricing.' },
  ];
  const known = new Set(groups.map((group) => group.prefix));
  const rest = settings.data.settings.filter(
    (setting) => ![...known].some((prefix) => setting.key.startsWith(prefix)),
  );

  const changed = Object.keys(draft);
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
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.prefix} className="rounded-lg border border-border bg-card p-4">
            <h2 className="pb-2 font-semibold">{group.title}</h2>
            <div className="divide-y divide-border-soft">
              {settings.data.settings
                .filter((setting) => setting.key.startsWith(group.prefix))
                .map(field)}
            </div>
            {group.prefix === 'mail.' && <TestLetter />}
            {group.prefix === 'captcha.' && <CaptchaWarning />}
          </section>
        ))}

        {rest.length > 0 && (
          <section className="rounded-lg border border-border bg-card p-4">
            {/* Настройка, для которой здесь ещё нет группы. Лучше показать под ключом,
                чем не показать вовсе: иначе новое поле пропадает молча. */}
            <h2 className="pb-2 font-semibold">Прочее</h2>
            <div className="divide-y divide-border-soft">{rest.map(field)}</div>
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
