'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
 * Резервные копии ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * Кабинет только просит: создание, проверка и выдача копии — заявки службе на сервере. Скачивание — после повторного
 * ввода пароля и кода второго фактора: в копии вся база.
 */

type Kind = 'daily' | 'manual' | 'update' | 'before-restore';

interface Backup {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly size: number;
  readonly created_at: string;
  readonly check: { at: string; ok: boolean; detail: string } | null;
}

interface Listing {
  readonly available: boolean;
  readonly generated_at: string | null;
  readonly items: Backup[];
  readonly last_export: { at: string; by: string; id: string } | null;
}

interface Run {
  readonly id: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}

interface LogChunk {
  readonly text: string;
  readonly next_offset: number;
  readonly run: Run;
}

const KIND_NAME: Record<Kind, string> = {
  daily: 'Ежедневная',
  manual: 'Вручную',
  update: 'Перед обновлением',
  'before-restore': 'Перед восстановлением',
};

const DAY_MS = 86_400_000;
/** Копии не скачивали дольше этого — кабинет напоминает: на том же сервере они не переживут потерю сервера. */
const EXPORT_STALE_DAYS = 14;

const size = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} МБ`
    : `${String(Math.max(1, Math.round(bytes / 1024)))} КБ`;

const ago = (value: string): string => {
  const days = Math.floor((Date.now() - Date.parse(value)) / DAY_MS);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${String(days)} дн. назад`;
};

/** Ждёт, пока служба выполнит заявку; провал превращает в понятную ошибку с последней строкой журнала. */
async function waitForRun(id: string, what: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const chunk = await request<LogChunk>(`/updates/${id}/log?offset=0`);
    if (chunk.run.status === 'succeeded') return;
    if (chunk.run.status === 'failed') {
      const last = chunk.text.trim().split('\n').pop() ?? '';
      throw new Error(`${what} не удалось${last === '' ? '' : `: ${last}`}`);
    }
    if (Date.now() > deadline) throw new Error(`${what}: служба слишком долго не отвечает`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export default function BackupsPage() {
  return (
    <ConsoleShell title="Резервные копии" requireRole={['admin']}>
      {() => <Backups />}
    </ConsoleShell>
  );
}

function Backups() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [restoreRun, setRestoreRun] = useState<string | undefined>(undefined);

  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => request<Listing>('/backups'),
    refetchInterval: 15_000,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
    // Копии пишет служба: список обновляется её проходом, поэтому пара повторных запросов вдогонку.
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['backups'] }), 2500);
  };

  /** Заявка службе и ожидание её исхода; результат — одной строкой над таблицей. */
  const act = useMutation({
    mutationFn: async (job: {
      key: string;
      path: string;
      body?: object;
      what: string;
      done: string;
    }) => {
      setBusy(job.key);
      setMessage(undefined);
      try {
        const queued = await request<{ request: { id: string } }>(job.path, {
          method: 'POST',
          ...(job.body === undefined ? {} : { body: job.body }),
        });
        await waitForRun(queued.request.id, job.what);
        setMessage({ ok: true, text: job.done });
      } catch (error) {
        setMessage({
          ok: false,
          text:
            error instanceof ApiError || error instanceof Error ? error.message : 'Не получилось',
        });
      } finally {
        setBusy(undefined);
        refresh();
      }
    },
  });

  if (list.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  if (list.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {list.error.message}
      </p>
    );
  }
  const { available, items, last_export: lastExport } = list.data;

  if (!available) return <NoListing onRequested={refresh} />;

  const exportStale =
    lastExport === null || Date.now() - Date.parse(lastExport.at) > EXPORT_STALE_DAYS * DAY_MS;

  return (
    <div className="flex max-w-[1100px] flex-col gap-4">
      <section
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
        aria-label="Состояние копий"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>
            Последняя скачанная копия:{' '}
            <span className={exportStale ? 'font-medium text-warn' : 'font-medium'}>
              {lastExport === null ? 'ни разу' : ago(lastExport.at)}
            </span>
          </p>
          <Button
            type="button"
            disabled={busy !== undefined}
            onClick={() => {
              act.mutate({
                key: 'create',
                path: '/backups/create',
                what: 'Копию',
                done: 'Копия снята.',
              });
            }}
          >
            {busy === 'create' ? 'Снимаем копию…' : 'Создать копию сейчас'}
          </Button>
        </div>
        {exportStale && (
          <p role="note" className="text-warn">
            Копии лежат только на этом сервере: если он потеряется, пропадут и они. Скачайте свежую
            копию и сохраните у себя.
          </p>
        )}
        {message !== undefined && (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={message.ok ? 'text-ok' : 'text-crit'}
          >
            {message.text}
          </p>
        )}
      </section>

      {restoreRun !== undefined && <RestoreProgress id={restoreRun} onFinished={refresh} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Откуда</TableHead>
              <TableHead className="h-8 text-right">Размер</TableHead>
              <TableHead className="h-8">Проверка</TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-crit">
                  Копий нет — база ничем не защищена. Нажмите «Создать копию сейчас».
                </TableCell>
              </TableRow>
            )}
            {items.map((backup) => (
              <TableRow key={backup.id}>
                <TableCell className="num">{moment(backup.created_at)}</TableCell>
                <TableCell>{KIND_NAME[backup.kind]}</TableCell>
                <TableCell className="num text-right">{size(backup.size)}</TableCell>
                <TableCell className="whitespace-normal">
                  {backup.check === null ? (
                    <span className="text-muted-foreground">не проверялась</span>
                  ) : backup.check.ok ? (
                    <span className="text-ok">
                      годна · {ago(backup.check.at)}
                      <span className="block text-muted-foreground">{backup.check.detail}</span>
                    </span>
                  ) : (
                    <span className="text-crit">
                      не годна
                      <span className="block text-muted-foreground">{backup.check.detail}</span>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <span className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy !== undefined}
                      onClick={() => {
                        act.mutate({
                          key: `verify:${backup.id}`,
                          path: '/backups/verify',
                          body: { id: backup.id },
                          what: 'Проверка',
                          done: 'Копия проверена.',
                        });
                      }}
                    >
                      {busy === `verify:${backup.id}` ? 'Проверяем…' : 'Проверить'}
                    </Button>
                    <Download backup={backup} disabled={busy !== undefined} onDone={refresh} />
                    <Restore
                      backup={backup}
                      disabled={busy !== undefined || restoreRun !== undefined}
                      onStarted={setRestoreRun}
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** «Скачать»: пароль и код второго фактора, потом служба готовит файл, и браузер его забирает. */
function Download({
  backup,
  disabled,
  onDone,
}: {
  backup: Backup;
  disabled: boolean;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  return (
    <FormDialog
      label="Скачать"
      title="Скачать копию"
      description={`${KIND_NAME[backup.kind]}, ${moment(backup.created_at)}`}
      variant="outline"
      size="xs"
      disabled={disabled}
    >
      <DialogForm
        submitLabel="Подготовить и скачать"
        canSubmit={password !== ''}
        onSubmit={async () => {
          const queued = await request<{ request: { id: string } }>('/backups/export', {
            method: 'POST',
            body: { id: backup.id, password, ...(code.trim() === '' ? {} : { code: code.trim() }) },
          });
          setPassword('');
          setCode('');
          await waitForRun(queued.request.id, 'Подготовить копию');
          // Файл отдаётся один раз и только заказавшему; сессия — в cookie, поэтому достаточно перейти по адресу.
          window.location.assign(`/api/backups/exports/${queued.request.id}`);
          onDone();
        }}
      >
        <p className="text-muted-foreground sm:col-span-2">
          В копии вся база, включая данные людей. Сохраните файл в надёжном месте и не пересылайте
          его.
        </p>
        <DialogField label="Ваш пароль" wide>
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </DialogField>
        <DialogField
          label="Код второго фактора"
          wide
          hint="Шесть цифр из приложения. Если второй фактор не подключён — оставьте пустым."
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

/** Слово, которое нужно ввести: то же, что требует API. */
const RESTORE_PHRASE = 'ВОССТАНОВИТЬ';

/**
 * «Восстановить»: самое опасное действие раздела. Окно говорит, что именно будет и что пропадёт, и требует пароль, код
 * второго фактора и слово — случайным нажатием его не вызвать.
 */
function Restore({
  backup,
  disabled,
  onStarted,
}: {
  backup: Backup;
  disabled: boolean;
  onStarted: (runId: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');

  return (
    <FormDialog
      label="Восстановить"
      title="Восстановить базу из копии"
      description={`${KIND_NAME[backup.kind]}, ${moment(backup.created_at)}`}
      variant="outline"
      size="xs"
      disabled={disabled}
    >
      <DialogForm
        submitLabel="Восстановить"
        tone="danger"
        canSubmit={password !== '' && phrase === RESTORE_PHRASE}
        onSubmit={async () => {
          const queued = await request<{ request: { id: string } }>('/backups/restore', {
            method: 'POST',
            body: {
              id: backup.id,
              password,
              phrase,
              ...(code.trim() === '' ? {} : { code: code.trim() }),
            },
          });
          setPassword('');
          setCode('');
          setPhrase('');
          onStarted(queued.request.id);
        }}
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <p className="font-medium text-crit">
            Всё, что записано после {moment(backup.created_at)}, пропадёт из рабочей базы: платежи,
            звонки, новые клиенты.
          </p>
          <p className="text-muted-foreground">
            Сначала снимается страховочная копия нынешней базы, потом площадка останавливается на
            несколько минут. Нынешняя база не удаляется, а откладывается на диске до следующего
            восстановления. Если после восстановления службы не поднимутся, прежняя база вернётся
            сама. После восстановления кабинет попросит войти заново — это нормально.
          </p>
        </div>
        <DialogField label="Ваш пароль" wide>
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </DialogField>
        <DialogField
          label="Код второго фактора"
          wide
          hint="Если второй фактор не подключён — оставьте пустым."
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </DialogField>
        <DialogField label={`Для подтверждения введите слово ${RESTORE_PHRASE}`} wide>
          <Input
            autoComplete="off"
            value={phrase}
            onChange={(event) => {
              setPhrase(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

/**
 * Ход восстановления. Пока оно идёт, API останавливается и не отвечает — это штатно, поэтому опрос не считает обрыв
 * ошибкой, а пишет «площадка остановлена» и продолжает. Журнал — файл службы, он переживает всё.
 */
function RestoreProgress({ id, onFinished }: { id: string; onFinished: () => void }) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'running' | 'offline' | 'succeeded' | 'failed'>('running');
  const offset = useRef(0);

  useEffect(() => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const chunk = await request<LogChunk>(
            `/updates/${id}/log?offset=${String(offset.current)}`,
          );
          offset.current = chunk.next_offset;
          if (chunk.text !== '') setText((previous) => previous + chunk.text);
          if (chunk.run.status !== 'running') {
            setPhase(chunk.run.status);
            onFinished();
            return;
          }
          setPhase('running');
        } catch {
          setPhase('offline');
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [id, onFinished]);

  return (
    <section
      aria-label="Восстановление"
      className="flex flex-col gap-2 rounded-lg border border-warn bg-card p-3"
    >
      <h2 className="font-semibold">
        {phase === 'succeeded'
          ? 'Восстановление завершено'
          : phase === 'failed'
            ? 'Восстановление не удалось'
            : 'Идёт восстановление'}
      </h2>
      {phase === 'offline' && (
        <p role="status" className="text-warn">
          Площадка остановлена на время восстановления: страница продолжит сама.
        </p>
      )}
      {phase === 'failed' && (
        <p role="alert" className="text-crit">
          Прежняя база на месте или возвращена — смотрите журнал ниже.
        </p>
      )}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[13px]">
        {text}
      </pre>
    </section>
  );
}

/**
 * Служба копий ещё не записала список: после обновления она подхватывает новый код по таймеру (до десяти минут). Кнопка
 * не ждёт таймера: простая заявка будит службу сразу, и список появляется за несколько секунд.
 */
function NoListing({ onRequested }: { onRequested: () => void }) {
  const ask = useMutation({
    mutationFn: () => request('/updates/refresh', { method: 'POST', body: {} }),
    onSuccess: () => {
      onRequested();
      // Служба просыпается по заявке и записывает список в конце прохода: пара повторных запросов вдогонку.
      for (const delay of [3000, 6000, 10000]) setTimeout(onRequested, delay);
    },
  });
  return (
    <section className="flex max-w-[60ch] flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <p>
        Служба копий на сервере ещё не записала список. После обновления она подхватывает новый код
        сама, это занимает до десяти минут. Можно не ждать.
      </p>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={ask.isPending || ask.isSuccess}
          onClick={() => {
            ask.mutate();
          }}
        >
          {ask.isSuccess
            ? 'Запросили — список появится через несколько секунд'
            : 'Запросить список сейчас'}
        </Button>
        {ask.isError && (
          <span role="alert" className="text-crit">
            {ask.error.message}
          </span>
        )}
      </div>
    </section>
  );
}
