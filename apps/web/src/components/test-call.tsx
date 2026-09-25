'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { TestCallStatus } from '@zvonix/shared';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { TEST_CALL_STATUS_TEXT, testCallFailureText } from '@/lib/labels';

/**
 * Тестовый звонок с SIM ([ADR-0055](../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)) —
 * одно окно на кабинет партнёра и на администратора: различаются только пути.
 *
 * Площадка звонит с карты на введённый номер; ответивший слышит пять коротких сигналов.
 * Окно после отправки не закрывается: дозвон идёт до сорока секунд, и итог показывается
 * в нём же — ради итога проба и делается.
 */

interface TestCall {
  readonly id: string;
  readonly destination: string;
  readonly status: TestCallStatus;
  readonly hangup_cause: string | null;
  readonly sip_status: string | null;
  readonly sip_phrase: string | null;
  readonly rang: boolean;
  readonly talk_seconds: number | null;
  readonly finished_at: string | null;
}

/** Пути партнёра и администратора. */
export type TestCallScope = 'partner' | 'admin';

function paths(scope: TestCallScope, simId: string) {
  return scope === 'partner'
    ? { start: `/partner/sim-cards/${simId}/test-call`, read: '/partner/test-calls' }
    : { start: `/sim-cards/${simId}/test-call`, read: '/test-calls' };
}

export function TestCallButton({
  scope,
  simId,
  msisdn,
}: {
  scope: TestCallScope;
  simId: string;
  msisdn: string;
}) {
  const [callId, setCallId] = useState<string | undefined>(undefined);

  return (
    <FormDialog
      label="Тестовый звонок"
      variant="outline"
      title="Тестовый звонок"
      description={
        <>
          С карты <span className="num">{msisdn}</span>. Площадка за пробу ничего не списывает.
        </>
      }
      onOpenChange={(open) => {
        if (!open) setCallId(undefined);
      }}
    >
      {callId === undefined ? (
        <TestCallForm
          start={async (destination) => {
            const started = await request<{ test_call: TestCall }>(paths(scope, simId).start, {
              method: 'POST',
              body: { destination },
            });
            setCallId(started.test_call.id);
          }}
        />
      ) : (
        <TestCallResult
          readPath={`${paths(scope, simId).read}/${callId}`}
          onAgain={() => {
            setCallId(undefined);
          }}
        />
      )}
    </FormDialog>
  );
}

function TestCallForm({ start }: { start: (destination: string) => Promise<unknown> }) {
  const [destination, setDestination] = useState('');
  return (
    <DialogForm
      submitLabel="Позвонить"
      canSubmit={destination.trim() !== ''}
      keepOpen
      onSubmit={() => start(destination)}
    >
      <DialogField
        label="Куда звонить"
        hint="Ваш мобильный: возьмите трубку — услышите пять коротких сигналов"
        wide
      >
        <Input
          className="num"
          inputMode="tel"
          autoComplete="tel"
          spellCheck={false}
          autoFocus
          value={destination}
          placeholder="+7 913 042-41-23"
          onChange={(event) => {
            setDestination(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}

function TestCallResult({ readPath, onAgain }: { readPath: string; onAgain: () => void }) {
  const call = useQuery({
    queryKey: ['test-call', readPath],
    queryFn: () => request<{ test_call: TestCall }>(readPath).then((body) => body.test_call),
    // Пока идёт дозвон — опрос. Итог пришёл — ещё несколько секунд: ответ шлюза
    // и отметка о наборе приходят с записью о звонке чуть позже итога.
    refetchInterval: (query) => (awaitingDetails(query.state.data) ? 1500 : false),
  });

  const data = call.data;
  const done = data !== undefined && data.status !== 'dialing';

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 px-5 pb-4" role="status" aria-live="polite">
        {call.error instanceof ApiError && <ErrorNote error={call.error} />}
        {data === undefined ? (
          <p className="text-muted-foreground">Звоним…</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Номер <span className="num">{data.destination}</span>
            </p>
            <p className={toneOf(data.status)}>
              {data.status === 'failed'
                ? testCallFailureText(data)
                : TEST_CALL_STATUS_TEXT[data.status]}
            </p>
            {data.talk_seconds !== null && data.talk_seconds > 0 && (
              <p className="text-muted-foreground">
                Разговор <span className="num">{data.talk_seconds}</span> с
              </p>
            )}
          </>
        )}
      </div>
      {done && (
        <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
          <Button type="button" size="sm" variant="outline" onClick={onAgain}>
            Позвонить ещё
          </Button>
        </div>
      )}
    </div>
  );
}

/** Сколько ждать записи о звонке после итога. */
const DETAILS_WAIT_MS = 15_000;

function awaitingDetails(call: TestCall | undefined): boolean {
  if (call === undefined || call.status === 'dialing') return true;
  if (call.sip_status !== null || call.finished_at === null) return false;
  return Date.now() - new Date(call.finished_at).getTime() < DETAILS_WAIT_MS;
}

function toneOf(status: TestCallStatus): string {
  switch (status) {
    case 'answered':
    case 'busy':
    case 'no_answer':
      return 'text-ok';
    case 'failed':
    case 'unknown':
      return 'text-warn';
    case 'dialing':
      return '';
  }
}
