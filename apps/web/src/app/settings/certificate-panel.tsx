'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

type State = 'ok' | 'soon' | 'expired' | 'incomplete' | 'missing' | 'not_configured' | 'unknown';

interface Certificate {
  readonly available: boolean;
  readonly state: State;
  readonly checked_at: string | null;
  readonly domain: string | null;
  readonly expected_names: readonly string[];
  readonly covered_names: readonly string[];
  readonly missing_names: readonly string[];
  readonly issuer: string | null;
  readonly not_before: string | null;
  readonly not_after: string | null;
  readonly days_left: number | null;
  readonly auto_renew: boolean | null;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly last_run: {
    readonly id: string;
    readonly action: string;
    readonly status: 'running' | 'succeeded' | 'failed';
    readonly finished_at: string | null;
    readonly exit_code: number | null;
  } | null;
}

const CERTIFICATE_KEY = ['certificate'] as const;

const STATE: Record<State, { label: string; tone: string }> = {
  ok: { label: 'Действует', tone: 'bg-ok-soft text-ok' },
  soon: { label: 'Скоро истекает', tone: 'bg-warn-soft text-warn' },
  expired: { label: 'Истёк', tone: 'bg-crit-soft text-crit' },
  incomplete: { label: 'Не на все адреса', tone: 'bg-warn-soft text-warn' },
  missing: { label: 'Не выпущен', tone: 'bg-crit-soft text-crit' },
  not_configured: { label: 'Не нужен', tone: 'bg-muted text-muted-foreground' },
  unknown: { label: 'Ещё не прочитан', tone: 'bg-muted text-muted-foreground' },
};

const STATE_NOTE: Partial<Record<State, string>> = {
  not_configured: 'Кабинет открыт без домена (по SSH-туннелю): сертификат не выпускается.',
  unknown:
    'Служба обновления ещё не читала сертификат — обычно это пара минут после обновления до этого выпуска.',
  missing:
    'Сертификата на сервере нет. Выпустите его: адрес кабинета должен указывать на этот сервер.',
  expired: 'Срок истёк, браузеры предупреждают посетителей. Выпустите сертификат заново.',
  incomplete: 'Сертификат не закрывает все адреса. Выпустите его заново — он расширится.',
  soon: 'Автопродление должно было сработать раньше. Проверьте, включено ли оно, или выпустите вручную.',
};

function daysText(days: number | null): string {
  if (days === null) return '';
  if (days < 0) return ' · истёк';
  const mod10 = days % 10;
  const mod100 = days % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'день'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'дня'
        : 'дней';
  return ` · осталось ${String(days)} ${word}`;
}

/**
 * Раздел «Сертификат» в настройках площадки ([ADR-0083](../../../../../docs/adr/0083-sertifikat-v-nastroykah.md)).
 *
 * Состояние читается у API, а действия — заявки службе обновления: выпуск занимает десятки секунд, поэтому,
 * пока заявка идёт, раздел опрашивает состояние чаще и закрывает кнопки.
 */
export function CertificatePanel() {
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);

  const certificate = useQuery({
    queryKey: CERTIFICATE_KEY,
    queryFn: ({ signal }) => request<Certificate>('/certificate', { signal }),
    refetchInterval: (query) => (query.state.data?.busy === true ? 3_000 : 60_000),
  });

  const act = useMutation({
    mutationFn: (path: string) => request(path, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CERTIFICATE_KEY }),
  });
  const setAuto = useMutation({
    mutationFn: (enabled: boolean) =>
      request('/certificate/auto', { method: 'POST', body: { enabled } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CERTIFICATE_KEY }),
  });

  const log = useQuery({
    queryKey: ['certificate-log', certificate.data?.last_run?.id],
    enabled: showLog && certificate.data?.last_run?.id !== undefined,
    queryFn: ({ signal }) =>
      request<{ text: string }>(`/updates/${certificate.data?.last_run?.id ?? ''}/log?offset=0`, {
        signal,
      }),
  });

  if (certificate.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  const loadError = certificate.error instanceof ApiError ? certificate.error : undefined;
  if (loadError !== undefined) return <ErrorNote error={loadError} />;
  const data = certificate.data;
  if (data === undefined) return null;

  const chip = STATE[data.state];
  const note = STATE_NOTE[data.state];
  const failure = act.error instanceof ApiError ? act.error : undefined;
  const autoFailure = setAuto.error instanceof ApiError ? setAuto.error : undefined;
  const lockActions = data.busy || act.isPending || setAuto.isPending;
  const issuable = data.state !== 'not_configured' && data.available;
  const lastFailed = data.last_run?.status === 'failed' && data.last_run.action !== 'cert-check';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-sm px-2 py-0.5 font-medium ${chip.tone}`}>{chip.label}</span>
        {data.busy && <span className="text-warn">Выполняется…</span>}
      </div>
      {note !== undefined && <p className="text-muted-foreground">{note}</p>}
      {data.problem !== null && <p className="text-warn">{data.problem}</p>}

      {data.available && data.domain !== null && (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[180px_1fr]">
          <dt className="text-muted-foreground">Адрес кабинета</dt>
          <dd className="num">{data.domain}</dd>

          <dt className="text-muted-foreground">Закрывает адреса</dt>
          <dd className="num flex flex-wrap gap-x-3">
            {data.covered_names.length === 0 ? '—' : data.covered_names.join(', ')}
            {data.missing_names.length > 0 && (
              <span className="text-warn">нет: {data.missing_names.join(', ')}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Выпущен</dt>
          <dd>{moment(data.not_before)}</dd>

          <dt className="text-muted-foreground">Действует до</dt>
          <dd>
            {moment(data.not_after)}
            <span className="text-muted-foreground">{daysText(data.days_left)}</span>
          </dd>

          <dt className="text-muted-foreground">Выпустил</dt>
          <dd>{data.issuer ?? '—'}</dd>

          <dt className="text-muted-foreground">Проверено</dt>
          <dd>{moment(data.checked_at)}</dd>
        </dl>
      )}

      {data.available && data.state !== 'not_configured' && (
        <div className="flex items-start gap-3 border-t border-border-soft pt-3">
          <Switch
            id="certificate-auto"
            checked={data.auto_renew === true}
            disabled={lockActions || data.auto_renew === null}
            onCheckedChange={(next) => {
              setAuto.mutate(next);
            }}
          />
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1">
              <label htmlFor="certificate-auto">Продлевать автоматически</label>
              <Hint label="Пояснение">
                <p>
                  Включает таймер продления на сервере: он проверяет сертификат дважды в сутки и
                  обновляет его примерно за 30 дней до конца срока. Выключайте только если
                  продлеваете вручную.
                </p>
              </Hint>
            </span>
            {data.auto_renew === null && (
              <p className="text-muted-foreground">Состояние таймера прочитать не удалось.</p>
            )}
            {data.auto_renew === false && (
              <p className="text-warn">Выключено: сертификат не продлится сам.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-3">
        <ConfirmAction
          label="Выпустить сертификат"
          variant="default"
          size="default"
          tone="neutral"
          disabled={lockActions || !issuable}
          title="Выпустить сертификат заново"
          consequence={
            <>
              <p>
                Сертификат будет выпущен на все адреса кабинета
                {data.expected_names.length > 0 && <>: {data.expected_names.join(', ')}</>}. Это
                занимает до минуты, сайт при этом не останавливается.
              </p>
              <p>
                У Let’s Encrypt есть пределы на повторные выпуски, поэтому нажимать чаще раза в
                десять минут нельзя, а лишний раз без причины не стоит.
              </p>
            </>
          }
          confirmLabel="Выпустить"
          onConfirm={() => act.mutateAsync('/certificate/issue')}
        />
        <Button
          type="button"
          variant="outline"
          disabled={lockActions}
          onClick={() => {
            act.mutate('/certificate/check');
          }}
        >
          Проверить
        </Button>
      </div>

      {failure !== undefined && <ErrorNote error={failure} />}
      {autoFailure !== undefined && <ErrorNote error={autoFailure} />}

      {lastFailed && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-crit-soft p-3">
          <p className="text-crit">
            Последнее действие не удалось
            {data.last_run.finished_at !== null ? `: ${moment(data.last_run.finished_at)}` : ''}.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setShowLog((value) => !value);
              }}
            >
              {showLog ? 'Скрыть журнал' : 'Показать журнал'}
            </Button>
          </div>
          {showLog && (
            <pre className="num max-h-60 overflow-auto whitespace-pre-wrap rounded-sm bg-card p-2 text-xs">
              {log.isPending ? 'Загружаем…' : (log.data?.text ?? 'Журнал недоступен')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
