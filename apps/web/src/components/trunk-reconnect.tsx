'use client';

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { ErrorNote } from '@/components/error-note';
import { StatusDot } from '@/components/status-dot';
import { ROW_ICON } from '@/components/table-parts';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';
import { ApiError, request } from '@/lib/api';

/**
 * SIP-провайдер остановлен из-за неверного логина или пароля
 * ([ADR-0123](../../../../docs/adr/0123-ostanovka-provaydera-po-nevernomu-parolyu.md)): состояние в строке и значок
 * «Подключить снова». Одинаково у партнёра и у администратора.
 */
export function TrunkAuthBlocked() {
  return (
    <StatusDot
      tone="crit"
      label="неверный пароль"
      reason="Провайдер не принял логин или пароль. Узел перестал подключаться, чтобы провайдер не заблокировал адрес за подбор пароля. Исправьте логин или пароль в настройках — подключение пойдёт само; если исправили у провайдера — нажмите «Подключить снова»"
      phoneDot
    />
  );
}

export function TrunkReconnectButton({
  scope,
  trunkId,
  invalidate,
}: {
  scope: 'partner' | 'admin';
  trunkId: string;
  invalidate: QueryKey;
}) {
  const queryClient = useQueryClient();
  const reconnect = useMutation({
    mutationFn: () =>
      request<unknown>(`${scope === 'partner' ? '/partner' : ''}/sip-trunks/${trunkId}/reconnect`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invalidate }),
  });
  return (
    <>
      <WithTooltip label="Подключить снова — если пароль исправили у провайдера">
        <Button
          {...ROW_ICON}
          aria-label="Подключить снова"
          disabled={reconnect.isPending}
          onClick={() => {
            reconnect.mutate();
          }}
        >
          <RotateCcw aria-hidden className="size-4" />
        </Button>
      </WithTooltip>
      {reconnect.error instanceof ApiError && <ErrorNote error={reconnect.error} />}
    </>
  );
}
