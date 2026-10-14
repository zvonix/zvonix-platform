'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

type State = 'ok' | 'soon' | 'invalid' | 'unknown';

interface GithubToken {
  readonly available: boolean;
  readonly state: State;
  readonly repository: string | null;
  readonly checked_at: string | null;
  readonly expires_at: string | null;
  readonly days_left: number | null;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly last_run: {
    readonly id: string;
    readonly status: 'running' | 'succeeded' | 'failed';
    readonly finished_at: string | null;
  } | null;
}

const KEY = ['updates', 'github-token'] as const;

const STATE: Record<State, { label: string; tone: string }> = {
  ok: { label: 'Принимается', tone: 'bg-ok-soft text-ok' },
  soon: { label: 'Скоро кончится', tone: 'bg-warn-soft text-warn' },
  invalid: { label: 'Не принимается', tone: 'bg-crit-soft text-crit' },
  unknown: { label: 'Ещё не проверен', tone: 'bg-muted text-muted-foreground' },
};

/**
 * Токен GitHub, которым площадка скачивает выпуски ([ADR-0084](../../../../../docs/adr/0084-token-github-v-nastroykah.md)).
 *
 * Токен вводится сюда и уходит службе обновления одной заявкой; назад он не показывается — только состояние
 * и срок. Пока заявка идёт, поле закрыто, а раздел опрашивает состояние чаще.
 */
export function GithubTokenPanel() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<GithubToken>('/updates/github-token', { signal }),
    refetchInterval: (query) => (query.state.data?.busy === true ? 3_000 : 60_000),
  });

  const save = useMutation({
    mutationFn: () => request('/updates/github-token', { method: 'POST', body: { token } }),
    onSuccess: () => {
      // Токен из поля убирается сразу: в памяти страницы он дольше не нужен.
      setToken('');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (state.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  const data = state.data;
  if (data === undefined) {
    return state.error instanceof ApiError ? <ErrorNote error={state.error} /> : null;
  }

  const chip = STATE[data.state];
  const failure = save.error instanceof ApiError ? save.error : undefined;
  const lastFailed = data.last_run?.status === 'failed' && !data.busy;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-sm px-2 py-0.5 font-medium ${chip.tone}`}>{chip.label}</span>
        {data.busy && <span className="text-warn">Проверяется…</span>}
      </div>

      {data.problem !== null && <p className="text-warn">{data.problem}</p>}

      {data.available && (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[180px_1fr]">
          <dt className="text-muted-foreground">Репозиторий</dt>
          <dd className="num">{data.repository ?? '—'}</dd>

          <dt className="text-muted-foreground">Действует до</dt>
          <dd>
            {data.expires_at === null ? 'срок не ограничен' : moment(data.expires_at)}
            {data.days_left !== null && (
              <span className="text-muted-foreground">
                {' '}
                · осталось {String(data.days_left)} дн.
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">Проверено</dt>
          <dd>{moment(data.checked_at)}</dd>
        </dl>
      )}

      <form
        className="flex flex-col gap-2 border-t border-border-soft pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim() !== '' && !data.busy) save.mutate();
        }}
      >
        <label htmlFor="github-token" className="inline-flex items-center gap-1">
          Новый токен GitHub
          <Hint label="Какой токен нужен">
            <p>
              Fine-grained токен, выпущенный на организацию-владельца репозитория, с правом
              «Contents: Read-only» на репозиторий площадки и ограниченным сроком. Площадка проверит
              его у GitHub и только потом заменит прежний.
            </p>
          </Hint>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="github-token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="num max-w-[420px] flex-1"
            placeholder="github_pat_…"
            value={token}
            disabled={data.busy || save.isPending}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
          <Button type="submit" disabled={token.trim() === '' || data.busy || save.isPending}>
            Проверить и сохранить
          </Button>
        </div>
        <p className="text-muted-foreground">
          Токен не показывается после сохранения и не попадает в журнал действий.
        </p>
      </form>

      {failure !== undefined && <ErrorNote error={failure} />}
      {lastFailed && (
        <p className="rounded-md border border-border bg-crit-soft p-3 text-crit">
          Последний токен не принят — прежний остался в работе
          {data.last_run.finished_at !== null ? `: ${moment(data.last_run.finished_at)}` : ''}.
        </p>
      )}
    </div>
  );
}
