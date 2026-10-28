'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, request } from '@/lib/api';

/**
 * Какие письма получать — выбирает сам владелец аккаунта
 * ([ADR-0104](../../../../docs/adr/0104-pisma-nastraivaet-sam-poluchatel.md)). Письмо, которое не рассылает площадка,
 * показывается выключенным и не переключается: обещать его было бы неправдой.
 */

interface Letter {
  readonly enabled: boolean;
  readonly platform_enabled: boolean;
}

interface ClientNotifications {
  readonly low_balance: Letter & {
    readonly threshold: number | null;
    readonly platform_threshold: number;
  };
  readonly payment_decision: Letter;
}

interface PartnerNotifications {
  readonly equipment_suspended: Letter;
  readonly poor_connection: Letter;
}

const CLIENT_KEY = ['my', 'notifications'] as const;
const PARTNER_KEY = ['partner', 'notifications'] as const;

function useNotifications<T>(key: readonly string[], endpoint: string) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => request<T>(endpoint) });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => request<T>(endpoint, { method: 'PUT', body }),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
    },
  });
  return { query, save };
}

function Card({ children, error }: { children: ReactNode; error: unknown }) {
  return (
    <section className="flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Письма</h2>
      {children}
      {error instanceof ApiError && <ErrorNote error={error} />}
    </section>
  );
}

function Toggle({
  letter,
  label,
  pending,
  onChange,
}: {
  letter: Letter;
  label: string;
  pending: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <Switch
        checked={letter.platform_enabled && letter.enabled}
        disabled={!letter.platform_enabled || pending}
        onCheckedChange={onChange}
      />
      <span>
        {label}
        {!letter.platform_enabled && (
          <span className="text-muted-foreground"> · площадка не рассылает</span>
        )}
      </span>
    </label>
  );
}

export function ClientNotificationSettings() {
  const { query, save } = useNotifications<ClientNotifications>(
    CLIENT_KEY,
    '/client/notifications',
  );
  if (query.data === undefined) return null;
  const { low_balance: low, payment_decision: payment } = query.data;
  return (
    <Card error={save.error}>
      <Toggle
        letter={low}
        label="На счёте мало денег"
        pending={save.isPending}
        onChange={(next) => {
          save.mutate({ lowBalance: next });
        }}
      />
      {low.platform_enabled && low.enabled && (
        <Threshold
          key={String(low.threshold)}
          current={low.threshold}
          fallback={low.platform_threshold}
          pending={save.isPending}
          onSave={(threshold) => {
            save.mutate({ lowBalanceThreshold: threshold });
          }}
        />
      )}
      <Toggle
        letter={payment}
        label="Решение по заявке на пополнение"
        pending={save.isPending}
        onChange={(next) => {
          save.mutate({ paymentDecision: next });
        }}
      />
    </Card>
  );
}

/** Свой порог «мало денег», рублей; пусто — порог площадки. */
function Threshold({
  current,
  fallback,
  pending,
  onSave,
}: {
  current: number | null;
  fallback: number;
  pending: boolean;
  onSave: (threshold: number | null) => void;
}) {
  const [text, setText] = useState(current === null ? '' : String(current));
  const value = text.trim() === '' ? null : Number(text.trim());
  const valid = value === null || (Number.isInteger(value) && value >= 1 && value <= 10_000_000);
  return (
    <div className="flex flex-wrap items-center gap-2 pl-11">
      <span className="text-muted-foreground">когда меньше</span>
      <Input
        aria-label="Порог, рублей"
        inputMode="numeric"
        className="num h-8 w-28"
        placeholder={String(fallback)}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <span className="text-muted-foreground">₽</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!valid || value === current || pending}
        onClick={() => {
          onSave(value);
        }}
      >
        Сохранить
      </Button>
    </div>
  );
}

export function PartnerNotificationSettings() {
  const { query, save } = useNotifications<PartnerNotifications>(
    PARTNER_KEY,
    '/partner/notifications',
  );
  if (query.data === undefined) return null;
  const { equipment_suspended: suspended, poor_connection: poor } = query.data;
  return (
    <Card error={save.error}>
      <Toggle
        letter={suspended}
        label="SIM или шлюз отключились из-за отказов"
        pending={save.isPending}
        onChange={(next) => {
          save.mutate({ equipmentSuspended: next });
        }}
      />
      <Toggle
        letter={poor}
        label="SIM или шлюз почти не соединяют"
        pending={save.isPending}
        onChange={(next) => {
          save.mutate({ poorConnection: next });
        }}
      />
    </Card>
  );
}
