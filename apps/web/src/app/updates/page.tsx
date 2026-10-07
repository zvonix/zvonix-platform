'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

/**
 * Обновление площадки из кабинета ([ADR-0074](../../../../../docs/adr/0074-obnovlenie-iz-adminki.md)).
 *
 * Кабинет только просит: заявку в очередь ставит API, выкладку делает служба на сервере, журнал — её файл.
 * Выкладка перезапускает и сам кабинет, поэтому страница переживает обрыв связи: она продолжает опрос и
 * говорит об этом, а не показывает ошибку.
 */

type Action = 'deploy' | 'rollback' | 'refresh';
type Status = 'running' | 'succeeded' | 'failed';

interface Release {
  readonly tag: string;
  readonly name: string;
  readonly published_at: string | null;
  readonly prerelease: boolean;
  readonly notes: string;
}

interface Queued {
  readonly id: string;
  readonly action: Action;
  readonly tag: string | null;
  readonly by: string;
  readonly requested_at: string;
}

interface Run {
  readonly id: string;
  readonly action: Action;
  readonly tag: string | null;
  readonly by: string;
  readonly status: Status;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly exit_code: number | null;
}

interface Overview {
  readonly available: boolean;
  readonly current: { version: string | null; commit: string | null; builtAt: string | null };
  readonly releases_fetched_at: string | null;
  readonly releases: readonly Release[];
  readonly queue: readonly Queued[];
  readonly runs: readonly Run[];
}

interface LogChunk {
  readonly text: string;
  readonly next_offset: number;
  readonly run: Run;
}

const ACTION_NAME: Record<Action, string> = {
  deploy: 'Обновление',
  rollback: 'Откат',
  refresh: 'Проверка обновлений',
};

const STATUS_NAME: Record<Status, string> = {
  running: 'Идёт',
  succeeded: 'Готово',
  failed: 'Не удалось',
};

const STATUS_TONE: Record<Status, string> = {
  running: 'text-warn',
  succeeded: 'text-ok',
  failed: 'text-crit',
};

const runTitle = (run: { action: Action; tag: string | null }): string =>
  run.tag === null ? ACTION_NAME[run.action] : `${ACTION_NAME[run.action]} до ${run.tag}`;

export default function UpdatesPage() {
  return (
    <ConsoleShell title="Обновления" requireRole={['admin']}>
      {() => <Updates />}
    </ConsoleShell>
  );
}

function Updates() {
  const queryClient = useQueryClient();
  const [watched, setWatched] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['updates'],
    queryFn: ({ signal }) => request<Overview>('/updates', { signal }),
    // Пока что-то идёт или ждёт — часто; иначе редко. Обрыв связи во время выкладки — штатный.
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy =
        data !== undefined &&
        (data.queue.length > 0 || data.runs.some((run) => run.status === 'running'));
      return busy || query.state.status === 'error' ? 2_000 : 15_000;
    },
    retry: true,
    retryDelay: 1_500,
  });

  const act = useMutation({
    mutationFn: (input: { path: string; body?: object }) =>
      request<{ request: Queued }>(input.path, { method: 'POST', body: input.body ?? {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['updates'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/updates/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['updates'] }),
  });

  const data = overview.data;

  // Выкладка сменила версию — подпись в углу меню должна догнать её без перезагрузки страницы.
  const shownVersion = data?.current.version;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['release'] });
  }, [queryClient, shownVersion]);
  const running = data?.runs.find((run) => run.status === 'running');
  const latest = data?.runs[0];

  // Идущее обновление показывается само; завершённое — пока человек не выбрал другое.
  const shown = watched ?? running?.id ?? latest?.id ?? null;
  const busy =
    data !== undefined && (running !== undefined || data.queue.some((q) => q.action !== 'refresh'));

  // Что-то уже исполняется или ждёт службу (в том числе сама проверка): вторую заявку не принимаем.
  const working = running !== undefined || data?.queue.length !== 0;
  const deploy = (tag: string) => act.mutateAsync({ path: '/updates/deploy', body: { tag } });

  if (data === undefined) {
    return overview.error instanceof ApiError ? <ErrorNote error={overview.error} /> : null;
  }

  if (!data.available) {
    return (
      <p className="max-w-xl rounded-lg border border-border bg-card p-4 text-muted-foreground">
        Обновление из кабинета на этой площадке не настроено: нет службы обновления. Она ставится
        обычной выкладкой с сервера.
      </p>
    );
  }

  // GitHub отдаёт выпуски от новых к старым: всё, что выше работающего, — обновление, ниже — прежние версии.
  const currentIndex = data.releases.findIndex((release) => release.tag === data.current.version);
  const newer = currentIndex === -1 ? data.releases : data.releases.slice(0, currentIndex);
  const older = currentIndex === -1 ? [] : data.releases.slice(currentIndex + 1);
  // Плашка выше обновляет до самой новой версии; в таблице остаются только промежуточные, без второй такой же кнопки.
  const hasBanner = data.current.version !== null && data.releases.length > 0;
  const others = hasBanner ? newer.slice(1) : newer;

  return (
    <div className="flex flex-col gap-4">
      {overview.isError && (
        <p
          role="status"
          className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-warn"
        >
          Нет связи с площадкой — вероятно, она перезапускается. Страница переподключится сама.
        </p>
      )}

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card p-4">
        <div>
          <div className="text-muted-foreground">Сейчас работает</div>
          <div className="num text-lg font-semibold">
            {data.current.version ?? 'сборка не из выпуска'}
          </div>
          <div className="num text-muted-foreground">
            {data.current.commit === null ? '' : `${data.current.commit.slice(0, 7)} · `}
            {data.current.builtAt === null ? '' : `собрана ${moment(data.current.builtAt)}`}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={act.isPending || working}
            onClick={() => {
              act.mutate({ path: '/updates/refresh' });
            }}
          >
            {working ? 'Идёт работа…' : 'Проверить обновления'}
          </Button>
          <ConfirmAction
            label="Вернуться на прежний выпуск"
            title="Вернуться на прежний выпуск"
            consequence="Службы переключатся на предыдущую версию кода и перезапустятся на несколько секунд. Изменения в базе не откатываются — для этого есть копия, снятая перед обновлением."
            confirmLabel="Вернуться"
            disabled={busy}
            onConfirm={() => act.mutateAsync({ path: '/updates/rollback' })}
          />
        </div>
      </section>

      {act.error instanceof ApiError && <ErrorNote error={act.error} />}
      {cancel.error instanceof ApiError && <ErrorNote error={cancel.error} />}

      {data.queue.length > 0 && (
        <section aria-label="Очередь" className="flex flex-col gap-2">
          {data.queue.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
            >
              <span className="text-warn">Ждёт службу</span>
              <span>{runTitle(item)}</span>
              <span className="text-muted-foreground">{item.by}</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={cancel.isPending}
                onClick={() => {
                  cancel.mutate(item.id);
                }}
              >
                Отменить
              </Button>
            </div>
          ))}
        </section>
      )}

      {shown !== null && <RunConsole key={shown} runId={shown} />}

      {hasBanner && (
        <section
          aria-label="Новая версия"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4"
        >
          {newer[0] === undefined ? (
            <span className="text-ok">Установлена последняя версия</span>
          ) : (
            <>
              <div>
                <div className="font-semibold">
                  Доступно обновление до <span className="num">{newer[0].tag}</span>
                  {newer.length > 1 && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      · новых версий: {String(newer.length)}
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground">{summary(newer[0].notes)}</div>
              </div>
              <div className="ml-auto">
                <ConfirmAction
                  label={`Обновить до ${newer[0].tag}`}
                  title={`Обновить площадку до ${newer[0].tag}`}
                  consequence={UPDATE_CONSEQUENCE}
                  confirmLabel="Обновить"
                  tone="neutral"
                  variant="default"
                  disabled={busy}
                  onConfirm={() => deploy(newer[0]?.tag ?? '')}
                />
              </div>
            </>
          )}
        </section>
      )}

      <section aria-label="Выпуски" className="flex flex-col gap-2">
        <h2 className="font-semibold">
          Выпуски{' '}
          <span className="font-normal text-muted-foreground">
            {data.releases_fetched_at === null
              ? ''
              : `проверено ${moment(data.releases_fetched_at)}`}
          </span>
        </h2>
        {data.releases.length === 0 ? (
          <p className="text-muted-foreground">
            Список пуст. Нажмите «Проверить обновления» — служба спросит GitHub.
          </p>
        ) : (
          <>
            {others.length > 0 && (
              <ReleaseTable releases={others} label="Обновить" busy={busy} onDeploy={deploy} />
            )}
            {older.length > 0 && (
              <details className="rounded-lg border border-border bg-card">
                <summary className="cursor-pointer px-3 py-2 text-muted-foreground">
                  Более ранние версии: {String(older.length)}
                </summary>
                <ReleaseTable
                  releases={older}
                  label="Вернуться"
                  returning
                  busy={busy}
                  onDeploy={deploy}
                />
              </details>
            )}
          </>
        )}
      </section>

      {data.runs.length > 0 && (
        <section aria-label="История" className="flex flex-col gap-2">
          <h2 className="font-semibold">История</h2>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Начато</TableHead>
                  <TableHead className="h-8">Что</TableHead>
                  <TableHead className="hidden h-8 sm:table-cell">Кто</TableHead>
                  <TableHead className="h-8">Итог</TableHead>
                  <TableHead className="h-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <span className="num text-muted-foreground">{moment(run.started_at)}</span>
                    </TableCell>
                    <TableCell>{runTitle(run)}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {run.by}
                    </TableCell>
                    <TableCell className={STATUS_TONE[run.status]}>
                      {STATUS_NAME[run.status]}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        aria-pressed={shown === run.id}
                        onClick={() => {
                          setWatched(run.id);
                        }}
                      >
                        Журнал
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}

const UPDATE_CONSEQUENCE =
  'Перед миграциями снимется копия базы, затем код переключится и службы перезапустятся — кабинет и API будут недоступны несколько секунд, звонки на узлах продолжатся. Если выпуск не поднимется, вернётся прежний.';

const RETURN_CONSEQUENCE =
  'Это более ранняя версия. Код вернётся к ней, но изменения в базе, сделанные новыми версиями, не откатываются: старый код может с ними не работать. Возвращайтесь, только если знаете, что делаете; для отката на предыдущую версию есть отдельная кнопка.';

/** Первая непустая строка описания выпуска — главное, что в нём изменилось. */
const summary = (notes: string): string =>
  notes.split('\n').find((line) => line.trim() !== '') ?? '';

function ReleaseTable({
  releases,
  label,
  returning = false,
  busy,
  onDeploy,
}: {
  releases: readonly Release[];
  label: string;
  returning?: boolean;
  busy: boolean;
  onDeploy: (tag: string) => Promise<unknown>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableHead className="h-8">Выпуск</TableHead>
            <TableHead className="h-8">Дата</TableHead>
            <TableHead className="hidden h-8 sm:table-cell">Что нового</TableHead>
            <TableHead className="h-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {releases.map((release) => (
            <TableRow key={release.tag}>
              <TableCell>
                <span className="num font-semibold">{release.tag}</span>
                {release.prerelease && <span className="ml-2 text-warn">пробный</span>}
              </TableCell>
              <TableCell>
                <span className="num text-muted-foreground">{moment(release.published_at)}</span>
              </TableCell>
              <TableCell
                className="hidden max-w-md truncate text-muted-foreground sm:table-cell"
                title={release.notes}
              >
                {summary(release.notes)}
              </TableCell>
              <TableCell className="text-right">
                <ConfirmAction
                  label={label}
                  title={`${returning ? 'Вернуться на' : 'Обновить площадку до'} ${release.tag}`}
                  consequence={returning ? RETURN_CONSEQUENCE : UPDATE_CONSEQUENCE}
                  confirmLabel={label}
                  tone={returning ? 'danger' : 'neutral'}
                  size="xs"
                  disabled={busy}
                  onConfirm={() => onDeploy(release.tag)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Шаги выкладки — строки журнала вида «=== Название». Последний незавершённый — текущий. */
function stepsOf(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('=== '))
    .map((line) => line.slice(4).trim());
}

/**
 * Журнал одного обновления в реальном времени: опрос раз в секунду с запомненным смещением. Обрыв связи
 * (выкладка перезапускает API) — не ошибка: тот же запрос повторяется, пока API не вернётся.
 */
function RunConsole({ runId }: { runId: string }) {
  const [text, setText] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // Кнопка перезагрузки нужна, только если обновление закончилось на глазах: кабинет мог смениться.
  const [sawRunning, setSawRunning] = useState(false);
  const paneRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    let stopped = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      let next = 1_000;
      try {
        const chunk = await request<LogChunk>(`/updates/${runId}/log?offset=${String(offset)}`, {
          signal: controller.signal,
        });
        if (stopped) return;
        setReconnecting(false);
        setRun(chunk.run);
        if (chunk.run.status === 'running') setSawRunning(true);
        if (chunk.text !== '') setText((previous) => previous + chunk.text);
        offset = chunk.next_offset;
        // Закончилось и всё прочитано — опрос не нужен.
        if (chunk.run.status !== 'running' && chunk.text === '') return;
        if (chunk.text !== '') next = 100;
      } catch (error) {
        if (stopped) return;
        // Служба перезапускается — штатный миг выкладки. Отказ API (например, 404) тоже повторяется,
        // но не чаще раза в секунду.
        setReconnecting(!(error instanceof ApiError) || error.status === 0 || error.status >= 502);
      }
      timer = setTimeout(() => void poll(), next);
    };
    void poll();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  // Новые строки прокручивают окно вниз, пока человек сам не поднялся выше.
  useEffect(() => {
    const pane = paneRef.current;
    if (pane !== null && followRef.current) pane.scrollTop = pane.scrollHeight;
  }, [text]);

  const steps = stepsOf(text);
  const done = run?.status !== undefined && run.status !== 'running';

  return (
    <section aria-label="Ход обновления" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{run === null ? 'Ход обновления' : runTitle(run)}</h2>
        {run !== null && <span className={STATUS_TONE[run.status]}>{STATUS_NAME[run.status]}</span>}
        {reconnecting && <span className="text-warn">связь с площадкой прервалась — ждём её</span>}
        {sawRunning && run?.status === 'succeeded' && run.action !== 'refresh' && (
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => {
              window.location.reload();
            }}
          >
            Перезагрузить кабинет
          </Button>
        )}
      </div>

      {steps.length > 0 && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1">
          {steps.map((step, index) => {
            const last = index === steps.length - 1;
            const tone =
              last && !done
                ? 'text-warn'
                : last && run?.status === 'failed'
                  ? 'text-crit'
                  : 'text-ok';
            return (
              <li key={`${String(index)}-${step}`} className={tone}>
                {last && !done ? '…' : last && run?.status === 'failed' ? '✕' : '✓'} {step}
              </li>
            );
          })}
        </ol>
      )}

      <pre
        ref={paneRef}
        tabIndex={0}
        aria-label="Журнал выкладки"
        aria-live="off"
        onScroll={(event) => {
          const pane = event.currentTarget;
          followRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
        }}
        className={`num max-h-[50dvh] ${run?.action === 'refresh' ? 'min-h-12' : 'min-h-40'} overflow-auto rounded-lg border border-border bg-[#0f1115] p-3 text-xs leading-relaxed whitespace-pre-wrap text-[#d8dee9]`}
      >
        {text === ''
          ? done
            ? 'Журнал пуст.'
            : run?.action === 'refresh'
              ? 'Спрашиваем GitHub о новых версиях…'
              : 'Ждём первых строк…'
          : text}
      </pre>
    </section>
  );
}
