'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { SettingField, labelOf, type DraftValue, type SettingView } from './setting-field';

const SETTINGS_QUERY_KEY = ['settings'] as const;

interface SettingsResponse {
  readonly settings: SettingView[];
}

interface TestResult {
  readonly delivered: boolean;
  readonly error: string | null;
}

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
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);

  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => request<SettingsResponse>('/settings'),
  });

  const save = useMutation({
    mutationFn: (changes: Record<string, DraftValue>) =>
      request<SettingsResponse>('/settings', { method: 'PUT', body: { settings: changes } }),
    onSuccess: (response) => {
      // Ответ содержит новый список целиком — кладём его в кэш вместо повторного
      // запроса: лишнее обращение только даёт странице мигнуть.
      queryClient.setQueryData(SETTINGS_QUERY_KEY, response);
      setDraft({});
      setSavedAt(new Date().toLocaleTimeString('ru-RU'));
    },
  });

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

  if (settings.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  if (settings.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {settings.error.message}
      </p>
    );
  }

  const groups = [
    { title: 'Почта', prefix: 'mail.' },
    { title: 'Проверка «я не робот»', prefix: 'captcha.' },
  ];
  const known = new Set(groups.map((group) => group.prefix));
  const rest = settings.data.settings.filter(
    (setting) => ![...known].some((prefix) => setting.key.startsWith(prefix)),
  );

  const changed = Object.keys(draft);
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <div className="flex max-w-[1100px] flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.prefix} className="rounded-lg border border-border bg-card p-4">
            <h2 className="pb-2 font-semibold">{group.title}</h2>
            <div className="divide-y divide-border-soft">
              {settings.data.settings
                .filter((setting) => setting.key.startsWith(group.prefix))
                .map((setting) => (
                  <SettingField
                    key={setting.key}
                    setting={setting}
                    draft={draft[setting.key]}
                    onChange={(value) => {
                      change(setting.key, value);
                    }}
                  />
                ))}
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
            <div className="divide-y divide-border-soft">
              {rest.map((setting) => (
                <SettingField
                  key={setting.key}
                  setting={setting}
                  draft={draft[setting.key]}
                  onChange={(value) => {
                    change(setting.key, value);
                  }}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-background py-3">
        <Button
          type="button"
          disabled={changed.length === 0 || save.isPending}
          onClick={() => {
            save.mutate(draft);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>

        {changed.length > 0 && (
          <span className="text-muted-foreground">
            Не сохранено: {changed.map((key) => labelOf(key)).join(', ')}
          </span>
        )}

        {changed.length === 0 && savedAt !== undefined && (
          <span className="text-ok">
            Сохранено в {savedAt}. В соседнем процессе подействует в течение полуминуты.
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
  const [recipient, setRecipient] = useState('');

  const send = useMutation({
    mutationFn: () =>
      request<TestResult>('/settings/mail/test', {
        method: 'POST',
        body: recipient === '' ? {} : { recipient },
      }),
  });

  const failure = send.error instanceof ApiError ? send.error.message : undefined;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-3">
      <p className="text-muted-foreground">
        Пробное письмо идёт мимо очереди и возвращает ответ почтового сервера. Пустой адрес — письмо
        уйдёт на адрес из настройки выше. Сохраните изменения перед отправкой: проверяются
        сохранённые настройки, а не то, что набрано в полях.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          placeholder="Кому — или пусто"
          className="max-w-[240px]"
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={send.isPending}
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
      {failure !== undefined && (
        <p role="alert" className="text-crit">
          {failure}
        </p>
      )}
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
