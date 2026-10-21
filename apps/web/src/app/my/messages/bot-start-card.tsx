'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { BOT_GREETING_MAX, BOT_SHARE_BUTTON, botStartText } from '@zvonix/shared';

interface BotState {
  readonly available: boolean;
  readonly connection: { readonly enabled: boolean } | null;
  readonly settings: { readonly greeting: string | null; readonly fallback_accounts: boolean };
}

const KEY = ['client', 'messages', 'bot'] as const;

/**
 * Ответ бота, когда человек открыл вашу ссылку и нажал «Запустить»: один текст и кнопка «Поделиться номером». Живёт рядом с
 * шаблоном сообщения, чтобы все тексты клиента были в одном месте. Не подключён бот — карточки нет. Пустое поле — стандартный
 * текст. Сам текст хранится в настройках бота; здесь он только правится и показывается так, как его увидит человек.
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

  const text = draft ?? stored;
  const error = save.error instanceof ApiError ? save.error : undefined;
  const shown = botStartText(text.trim() === '' ? null : text.trim(), company);

  return (
    <section aria-label="Ответ бота при запуске" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="font-semibold">Ответ бота при запуске</h3>
        <Hint label="Про ответ бота при запуске">
          <p>
            Это единственное сообщение, которое бот отправляет сам, когда человек открыл вашу ссылку
            и нажал «Запустить». К нему всегда добавляется кнопка «{BOT_SHARE_BUTTON}»: без номера
            бот не сможет писать человеку. Пусто — стандартный текст. {'{название}'} заменяется
            названием вашей службы.
          </p>
        </Hint>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <textarea
            aria-label="Ответ бота при запуске"
            className="min-h-24 rounded-lg border border-border bg-background p-2 font-sans"
            maxLength={BOT_GREETING_MAX}
            placeholder="Стандартный текст. {название} — название вашей службы"
            value={text}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
          <span className="num text-muted-foreground">
            {String(text.length)} из {String(BOT_GREETING_MAX)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Как это выглядит</span>
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <p className="whitespace-pre-wrap">{shown}</p>
            <span className="inline-flex w-fit rounded-md border border-border bg-background px-3 py-1 font-medium">
              {BOT_SHARE_BUTTON}
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
            save.mutate(text);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить ответ'}
        </Button>
        {saved && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
      </div>
    </section>
  );
}
