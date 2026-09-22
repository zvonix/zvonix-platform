'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { CallFailureReason } from '@zvonix/shared';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { useChannels, useClients } from '@/lib/dictionaries';
import { FAILURE_REASON_FIX, FAILURE_REASON_NAME } from '@/lib/labels';

interface Node {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

interface Decision {
  readonly outcome: string;
  readonly reason: CallFailureReason | null;
  readonly sip_response: string | null;
  readonly call_id: string | null;
  readonly decision_ms: number;
  readonly candidates: readonly { gateway_id: string; sip_username: string; sim_card_id: string }[];
}

/**
 * «А сейчас позвонит?» — тот же расчёт, что и на настоящем вызове.
 *
 * Разбор идёт **с теми же побочными действиями**: заводится вызов, придерживаются
 * деньги и место на SIM. Расчёт вхолостую отвечал бы на другой вопрос, чем задан, —
 * настройка могла бы пройти проверку и не пройти резерв.
 *
 * До этой формы обработчик существовал, но вызвать его можно было только `curl`:
 * то есть проверить исправленный тариф человек мог, лишь попросив клиента позвонить.
 */
export function RoutePreview() {
  const clients = useClients();
  const channels = useChannels();
  const [clientId, setClientId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [destination, setDestination] = useState('');

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await request<{ nodes: Node[] }>('/nodes')).nodes,
    staleTime: 60_000,
  });

  // Проверка, не дождавшаяся ответа, могла состояться: завести вызов и придержать деньги.
  // Её повтор с той же формой идёт под тем же идентификатором — маршрутизация по нему
  // возвращает уже принятое решение и второго резерва не делает. Ответ получен или форма
  // другая — следующая проверка отвечает на новый вопрос и заводит новый вызов.
  const unanswered = useRef<{ key: string; callId: string } | null>(null);

  const check = useMutation({
    mutationFn: (input: { channelId: string; nodeId: string; destination: string }) => {
      const key = [input.channelId, input.nodeId, input.destination].join('|');
      // Идентификатор задаём здесь, чтобы разбор нашёлся в списке вызовов как обычный.
      const callId =
        unanswered.current?.key === key
          ? unanswered.current.callId
          : `preview-${crypto.randomUUID()}`;
      unanswered.current = { key, callId };
      return request<Decision>('/routing/preview', {
        method: 'POST',
        body: { callId, ...input },
      });
    },
    onSettled: (_decision, error) => {
      if (!(error instanceof ApiError && error.timedOut)) unanswered.current = null;
    },
  });

  const available = channels.rows.filter(
    (channel) => clientId === '' || channel.ownerId === clientId,
  );
  const ready = channelId !== '' && nodeId !== '' && destination.trim() !== '';
  const failed = [channels.error, nodes.error, check.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <div className="flex flex-col gap-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) check.mutate({ channelId, nodeId, destination: destination.trim() });
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Клиент</span>
          <select
            value={clientId}
            onChange={(event) => {
              setClientId(event.target.value);
              setChannelId('');
            }}
            className="h-9 w-[200px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {clients.rows.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Канал</span>
          <select
            value={channelId}
            onChange={(event) => {
              setChannelId(event.target.value);
            }}
            className="h-9 w-[220px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите</option>
            {available.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Узел</span>
          <select
            value={nodeId}
            onChange={(event) => {
              setNodeId(event.target.value);
            }}
            className="h-9 w-[180px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите</option>
            {(nodes.data ?? []).map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Номер</span>
          <Input
            className="num w-[180px]"
            placeholder="79001234567"
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value);
            }}
          />
        </label>

        <Button type="submit" size="sm" disabled={!ready || check.isPending}>
          Проверить
        </Button>
      </form>

      <p className="text-muted-foreground">
        Проверка идёт по настоящему пути и{' '}
        <strong className="font-semibold text-foreground">
          придерживает деньги и место на SIM
        </strong>
        , если маршрут нашёлся: расчёт вхолостую отвечал бы на другой вопрос. Резерв освобождается
        сам по сроку, а сам разбор виден в списке ниже как обычный вызов.
      </p>

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      {check.data !== undefined && <Verdict decision={check.data} />}
    </div>
  );
}

function Verdict({ decision }: { decision: Decision }) {
  const rejected = decision.outcome === 'rejected';

  return (
    <div
      className={`rounded-lg border p-3 ${rejected ? 'border-crit/40 bg-crit-soft' : 'border-ok/40 bg-ok-soft'}`}
    >
      <div className="font-semibold">
        {rejected ? 'Вызов не пройдёт' : 'Маршрут найден: вызов пройдёт'}
      </div>

      {decision.reason !== null && (
        <div className="pt-1">
          <div>{FAILURE_REASON_NAME[decision.reason]}</div>
          <div className="text-muted-foreground">{FAILURE_REASON_FIX[decision.reason]}</div>
        </div>
      )}

      {decision.candidates.length > 0 && (
        <div className="pt-1 text-muted-foreground">
          Кандидатов на терминацию: <span className="num">{decision.candidates.length}</span>. Узел
          перебирает их по порядку.
        </div>
      )}

      <div className="pt-1 text-faint">
        <span className="num">{decision.decision_ms} мс</span> на решение
        {decision.sip_response !== null && (
          <>
            {' · '}абонент услышал бы <span className="num">{decision.sip_response}</span>
          </>
        )}
        {decision.call_id !== null && (
          <>
            {' · '}вызов <span className="num">{decision.call_id}</span>
          </>
        )}
      </div>
    </div>
  );
}
