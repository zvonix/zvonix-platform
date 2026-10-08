'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Hint } from '@/components/hint';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { money } from '@/lib/money';

interface Terms {
  readonly message_price: string;
  readonly monthly_fee: string;
}

interface BotState {
  readonly available: boolean;
  readonly platform_available: boolean;
  readonly connection: {
    readonly enabled: boolean;
    readonly kind: 'platform' | 'own';
    readonly link: string;
    readonly fee_paid: boolean;
  } | null;
  readonly terms: Terms;
  readonly platform_terms: Terms;
  readonly own: {
    readonly bot: {
      readonly name: string;
      readonly username: string;
      readonly status: 'active' | 'disabled';
      readonly last_error: string | null;
    } | null;
    readonly terms: Terms;
  };
  readonly subscribers: { readonly total: number; readonly with_phone: number };
}

const KEY = ['client', 'messages', 'bot'] as const;

/** Условия одной строкой: «0,25 ₽ за сообщение, 100 ₽ в месяц»; нули — «бесплатно». */
function termsLine(terms: Terms): string {
  const message =
    Number(terms.message_price) === 0
      ? 'сообщения бесплатно'
      : `${money(terms.message_price)} за сообщение`;
  const month =
    Number(terms.monthly_fee) === 0 ? 'без платы за месяц' : `${money(terms.monthly_fee)} в месяц`;
  return `${message}, ${month}`;
}

/**
 * Бот MAX клиента ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): бот площадки одной кнопкой или
 * свой бот по токену. Пассажиры подписываются по ссылке и получают сообщения от бота.
 */
export function BotConnection() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<BotState>('/client/messages/bot', { signal }),
  });
  const store = (view: BotState) => queryClient.setQueryData(KEY, view);

  const connect = useMutation({
    mutationFn: () => request<BotState>('/client/messages/bot', { method: 'POST' }),
    onSuccess: store,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      request<BotState>('/client/messages/bot', { method: 'PATCH', body: { enabled } }),
    onSuccess: store,
  });

  const data = state.data;
  if (data === undefined || !data.available) return null;

  const { connection, subscribers, own } = data;
  const error = [connect.error, toggle.error, state.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  const saveToken = async (token: string) => {
    store(await request<BotState>('/client/messages/bot/own', { method: 'PUT', body: { token } }));
  };

  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Бот MAX</h2>
        <Hint label="Как работает бот">
          <p>
            Пассажир открывает вашу ссылку, нажимает «Запустить» и делится номером. После этого
            сообщения на его номер уходят от бота, а не с личного аккаунта.
          </p>
          <p className="mt-2">
            Бот пишет только тем, кто подписался по вашей ссылке. Остальным сообщения идут как
            обычно.
          </p>
        </Hint>
      </div>

      {connection !== null && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Работает через</dt>
            <dd translate="no">
              {connection.kind === 'own' && own.bot !== null
                ? `ваш бот @${own.bot.username}`
                : 'бот площадки'}
            </dd>
            <dt className="text-muted-foreground">Ссылка для пассажиров</dt>
            <dd className="num select-all break-all" translate="no">
              {connection.link}
            </dd>
            <dt className="text-muted-foreground">Условия</dt>
            <dd className="num">{termsLine(data.terms)}</dd>
            <dt className="text-muted-foreground">Подписчиков</dt>
            <dd className="num">
              {subscribers.total}, с номером — {subscribers.with_phone}
            </dd>
          </dl>

          <QrCode value={connection.link} label="QR-код ссылки для пассажиров" />

          {connection.enabled && !connection.fee_paid && (
            <p className="text-warn">
              Плата за месяц не взята: не хватает денег на счёте. Пока она не взята, сообщения идут
              обычным путём.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(connection.link)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => {
                      setCopied(false);
                    }, 2000);
                  })
                  .catch(() => undefined);
              }}
            >
              {copied ? 'Скопировано' : 'Копировать ссылку'}
            </Button>
            {connection.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={toggle.isPending}
                onClick={() => {
                  toggle.mutate(false);
                }}
              >
                Отключить
              </Button>
            ) : (
              <>
                <span className="rounded-md bg-warn-soft px-2 py-0.5 text-warn">Отключено</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => {
                    toggle.mutate(true);
                  }}
                >
                  Включить
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {connection?.kind !== 'platform' && data.platform_available && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={connection === null ? 'default' : 'outline'}
            size={connection === null ? 'default' : 'sm'}
            disabled={connect.isPending}
            onClick={() => {
              connect.mutate();
            }}
          >
            {connect.isPending ? 'Подключаем…' : 'Подключить бота площадки'}
          </Button>
          <span className="text-muted-foreground">{termsLine(data.platform_terms)}</span>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-1">
          <h3 className="font-medium">Свой бот</h3>
          <Hint label="Как подключить своего бота">
            <ol className="list-decimal pl-4">
              <li>Откройте business.max.ru и создайте бота. Название без чужих брендов.</li>
              <li>Дождитесь проверки бота в MAX: до 48 часов.</li>
              <li>Скопируйте токен бота и вставьте его сюда.</li>
            </ol>
            <p className="mt-2">Токен хранится зашифрованным и нигде не показывается.</p>
          </Hint>
        </div>

        {own.bot === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <FormDialog label="Подключить своего бота" title="Свой бот MAX" variant="outline">
              <OwnBotForm submitLabel="Подключить" terms={own.terms} onSave={saveToken} />
            </FormDialog>
            <span className="text-muted-foreground">{termsLine(own.terms)}</span>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Бот</dt>
              <dd translate="no">
                {own.bot.name} <span className="num text-faint">@{own.bot.username}</span>
              </dd>
              <dt className="text-muted-foreground">Состояние</dt>
              <dd>{own.bot.status === 'active' ? 'Подключён' : 'Отключён'}</dd>
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <FormDialog
                label="Заменить токен"
                title="Токен своего бота"
                variant="outline"
                size="sm"
              >
                <OwnBotForm submitLabel="Заменить" terms={own.terms} onSave={saveToken} />
              </FormDialog>
              {own.bot.status === 'active' && (
                <ConfirmAction
                  label="Отключить бота"
                  title="Отключить своего бота"
                  consequence="Площадка перестанет принимать события бота, подписчики останутся. Включить снова — вставьте токен заново."
                  confirmLabel="Отключить"
                  onConfirm={async () => {
                    store(
                      await request<BotState>('/client/messages/bot/own', { method: 'DELETE' }),
                    );
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>

      {error !== undefined && <ErrorNote error={error} />}
    </section>
  );
}

/** Окно с токеном своего бота: токен вводится скрытым и после отправки нигде не остаётся. */
function OwnBotForm({
  submitLabel,
  terms,
  onSave,
}: {
  submitLabel: string;
  terms: Terms;
  onSave: (token: string) => Promise<unknown>;
}) {
  const [token, setToken] = useState('');
  return (
    <DialogForm
      submitLabel={submitLabel}
      canSubmit={token.trim() !== ''}
      onSubmit={() => onSave(token.trim())}
    >
      <DialogField label="Токен бота">
        <Input
          type="password"
          className="num"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
      </DialogField>
      <p className="text-muted-foreground sm:col-span-2">{termsLine(terms)}</p>
    </DialogForm>
  );
}
