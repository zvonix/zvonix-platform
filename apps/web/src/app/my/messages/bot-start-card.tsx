'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { BOT_GREETING_MAX, BOT_START_DEFAULT, botStartParts } from '@zvonix/shared';

interface BotState {
  readonly available: boolean;
  readonly connection: { readonly enabled: boolean } | null;
  readonly settings: {
    readonly greeting: string | null;
    readonly fallback_accounts: boolean;
    readonly share_button: string;
  };
}

const KEY = ['client', 'messages', 'bot'] as const;

/**
 * Ответ бота, когда человек открыл вашу ссылку и нажал «Запустить»: один текст и кнопка «Поделиться номером». Живёт рядом с
 * шаблоном сообщения, чтобы все тексты клиента были в одном месте. Не подключён бот — карточки нет. Своего текста нет — в поле
 * стоит стандартный (раньше поле было пустым, а пример заполненным, и это читалось как ошибка — владелец, 2026-10-22); сохранённый
 * стандартный текст хранится как «своего нет».
 */
export function BotStartCard({ company }: { company: string }) {
  const queryClient = useQueryClient();
  const bot = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<BotState>('/client/messages/bot', { signal }),
  });
  const stored = bot.data?.settings.greeting ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Другая вкладка или смена бота обновили сохранённое — не держим старый черновик.
  useEffect(() => {
    setDraft(null);
  }, [stored]);

  const save = useMutation({
    mutationFn: (greeting: string) =>
      request<BotState>('/client/messages/bot/settings', { method: 'PATCH', body: { greeting } }),
    onSuccess: (state) => {
      queryClient.setQueryData(KEY, state);
      setDraft(null);
      setSaved(true);
    },
  });

  if (bot.data === undefined || !bot.data.available || bot.data.connection === null) return null;

  const text = draft ?? (stored === '' ? BOT_START_DEFAULT : stored);
  const standard = text.trim() === BOT_START_DEFAULT;
  const error = save.error instanceof ApiError ? save.error : undefined;
  const button = bot.data.settings.share_button;
  const shown = botStartParts(text.trim() === '' ? null : text.trim(), company, button);

  return (
    <section aria-label="Ответ бота при запуске" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="font-semibold">Ответ бота при запуске</h3>
        <Hint label="Про ответ бота при запуске">
          <p>
            Это единственное сообщение, которое бот отправляет сам, когда человек открыл вашу ссылку
            и нажал «Запустить». К нему всегда добавляется кнопка «{button}»: без номера бот не
            сможет писать человеку. {'{название}'} заменяется названием вашей службы.
          </p>
          <p className="mt-2">
            После вашего текста площадка всегда добавляет строку с призывом нажать кнопку — если в
            тексте нет её названия. Человеку, который пишет боту, не поделившись номером, бот
            напомнит об этом и покажет кнопку снова.
          </p>
        </Hint>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
          <textarea
            aria-label="Текст ответа бота"
            className="min-h-20 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-sans [field-sizing:content]"
            maxLength={BOT_GREETING_MAX}
            value={text}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {standard ? 'Стандартный текст' : 'Свой текст'}
            </span>
            <span className="num text-xs text-muted-foreground">
              {String(text.length)} из {String(BOT_GREETING_MAX)}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/40 p-3">
          <span className="text-sm font-medium">Как это выглядит</span>
          <div className="flex max-w-[92%] flex-col gap-2 rounded-2xl rounded-tl-sm bg-card px-3.5 py-2.5 shadow-sm">
            <p className="whitespace-pre-wrap">{shown.text}</p>
            {shown.call !== null && (
              <p className="flex flex-col gap-0.5">
                <span>{shown.call}</span>
                <span className="text-xs text-muted-foreground">добавляется всегда</span>
              </p>
            )}
            <span className="inline-flex w-full justify-center rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-primary">
              {button}
            </span>
          </div>
        </div>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={draft === null || save.isPending}
          onClick={() => {
            // Стандартный текст не храним копией: поменяется стандарт — поменяется и у клиента.
            save.mutate(standard ? '' : text);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить ответ'}
        </Button>
        {!standard && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(BOT_START_DEFAULT);
              setSaved(false);
            }}
          >
            Вернуть стандартный
          </Button>
        )}
        {saved && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
      </div>
    </section>
  );
}
