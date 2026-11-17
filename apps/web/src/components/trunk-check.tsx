'use client';

import { useMutation } from '@tanstack/react-query';
import { Activity, LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';

interface TrunkCheckResult {
  readonly summary: string;
  readonly details: string;
}

/**
 * Проверка связи узла с SIP-провайдером ([ADR-0122](../../../../docs/adr/0122-proverka-svyazi-s-sip-provayderom.md)):
 * значок в строке провайдера, рядом с тестовым звонком. Окно сразу запускает проверку — узел 35 с слушает трафик
 * к провайдеру и регистрируется, — и показывает итог одной фразой, подробности ниже.
 */
export function TrunkCheckButton({
  scope,
  trunk,
}: {
  scope: 'partner' | 'admin';
  trunk: { id: string; name: string };
}) {
  const label = 'Проверить связь с провайдером';
  return (
    <FormDialog
      label={<Activity aria-hidden className="size-4" />}
      tooltip={label}
      title={`Связь с провайдером «${trunk.name}»`}
      description="Узел АТС слушает трафик к провайдеру и сразу пробует зарегистрироваться"
      variant="ghost"
      size="icon-xs"
      className="size-7"
      wide
    >
      <TrunkCheck path={`${scope === 'partner' ? '/partner' : ''}/sip-trunks/${trunk.id}/check`} />
    </FormDialog>
  );
}

function TrunkCheck({ path }: { path: string }) {
  const check = useMutation({
    mutationFn: () => request<TrunkCheckResult>(path, { method: 'POST', body: {} }),
  });
  const { mutate } = check;
  // Окно монтирует содержимое только открытым: открыли — проверяем.
  useEffect(() => {
    mutate();
  }, [mutate]);

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      {check.isPending && (
        <p className="inline-flex items-center gap-2 text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Проверяю — около 40 секунд
        </p>
      )}
      {check.error instanceof ApiError && <ErrorNote error={check.error} />}
      {check.data !== undefined && (
        <>
          <p className="font-medium">{check.data.summary}</p>
          {check.data.details !== '' && (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {check.data.details}
            </pre>
          )}
        </>
      )}
      {!check.isPending && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              mutate();
            }}
          >
            Проверить ещё раз
          </Button>
        </div>
      )}
    </div>
  );
}
