'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_COMMENT_MAX, MAX_CHANNEL_CONCURRENT_CALLS } from '@zvonix/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { CopyButton } from '@/components/copy-button';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { SectionTabs } from '@/components/section-tabs';
import {
  SipCredentials,
  type IssuedCredentials,
  type SipAccount,
} from '@/components/sip-credentials';
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
import { integerFromInput, money } from '@/lib/money';
import { asr, useBreakdown } from '@/lib/reports';
import { ChannelSettings } from '../channel-settings';
import {
  CHANNELS_KEY,
  ConnectionState,
  StateBadge,
  ownedByClient,
  useChannels,
  type Channel,
} from '../channels';

export default function MyChannelPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConsoleShell title="Линия" cabinet="client">
      {() => <ChannelCard id={params.id} />}
    </ConsoleShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/my/channels"
      className="self-start text-primary underline-offset-4 hover:underline"
    >
      ← Все линии
    </Link>
  );
}

/**
 * Страница линии ([ADR-0101](../../../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md)):
 * подключение, настройки звонков, сводка. Отдельного обработчика нет — линия берётся из списка: их не больше пяти.
 */
function ChannelCard({ id }: { id: string }) {
  const list = useChannels();
  // Пароль показывается один раз: панель живёт над вкладками и не пропадает при обновлении списка.
  const [issued, setIssued] = useState<IssuedCredentials | undefined>();

  if (list.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  if (list.data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      </div>
    );
  }
  const channel = list.data.channels.find((row) => row.id === id);
  if (channel === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p>Такой линии нет — возможно, она удалена.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <BackLink />

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">{channel.name}</h2>
          <StateBadge channel={channel} />
        </div>
        {channel.comment !== null && (
          <p className="max-w-prose whitespace-pre-line text-muted-foreground">{channel.comment}</p>
        )}
        <Actions channel={channel} onIssued={setIssued} />
      </header>

      {issued !== undefined && (
        <SipCredentials
          title={issued.title}
          account={issued.account}
          onClose={() => {
            setIssued(undefined);
          }}
        />
      )}

      <SectionTabs
        tabs={[
          {
            id: 'connection',
            label: 'Подключение',
            content: <ConnectionTab channel={channel} server={list.data.server} />,
          },
          {
            id: 'routing',
            label: 'Настройки звонков',
            content: <ChannelSettings channelId={channel.id} />,
          },
          { id: 'summary', label: 'Сводка', content: <SummaryTab channel={channel} /> },
        ]}
      />
    </div>
  );
}

function Actions({
  channel,
  onIssued,
}: {
  channel: Channel;
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const refresh = () => queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
  const status = useMutation({
    mutationFn: (to: 'active' | 'suspended' | 'closed') =>
      request<{ channel: Channel }>(`/client/channels/${channel.id}/status`, {
        method: 'POST',
        body: { status: to },
      }),
    onSuccess: refresh,
  });
  const error = status.error instanceof ApiError ? status.error : undefined;
  const own = ownedByClient(channel);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {own && channel.status === 'active' && (
          <ConfirmAction
            label="Выключить"
            title={`Выключить линию «${channel.name}»`}
            consequence={
              <p>
                Новые вызовы через линию не пойдут, программа отключится. Идущие разговоры не
                рвутся.
              </p>
            }
            confirmLabel="Выключить"
            onConfirm={() => status.mutateAsync('suspended')}
          />
        )}
        {own && channel.status === 'suspended' && (
          <Button
            size="sm"
            disabled={status.isPending}
            onClick={() => {
              status.mutate('active');
            }}
          >
            Включить
          </Button>
        )}
        <EditChannel channel={channel} />
        <ConfirmAction
          label="Новый пароль"
          title={`Новый пароль линии «${channel.name}»`}
          consequence={
            <p>Прежний пароль перестанет работать: программу придётся настроить заново.</p>
          }
          confirmLabel="Выдать новый пароль"
          tone="neutral"
          onConfirm={async () => {
            const data = await request<{ account: SipAccount }>(
              `/client/channels/${channel.id}/credentials`,
              { method: 'POST' },
            );
            onIssued({
              title: `Новый доступ SIP для линии «${channel.name}»`,
              account: data.account,
            });
            await refresh();
          }}
        />
        {own && (
          <ConfirmAction
            label="Удалить"
            title={`Удалить линию «${channel.name}»`}
            consequence={
              <p>
                Линия удаляется навсегда, её вход перестаёт работать. Прошлые вызовы останутся в
                «Вызовах».
              </p>
            }
            confirmLabel="Удалить навсегда"
            variant="ghost"
            onConfirm={async () => {
              await status.mutateAsync('closed');
              router.push('/my/channels');
            }}
          />
        )}
        {!own && <span className="text-muted-foreground">Линией распоряжается площадка</span>}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}

/** Название, комментарий и предел одновременных — одним окном. */
function EditChannel({ channel }: { channel: Channel }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(channel.name);
  const [comment, setComment] = useState(channel.comment ?? '');
  const [limit, setLimit] = useState(
    channel.max_concurrent_calls === null ? '' : String(channel.max_concurrent_calls),
  );
  const parsedLimit = limit.trim() === '' ? null : integerFromInput(limit);
  const limitValid =
    parsedLimit === null ||
    (parsedLimit !== undefined && parsedLimit >= 1 && parsedLimit <= MAX_CHANNEL_CONCURRENT_CALLS);

  return (
    <FormDialog
      label="Изменить"
      title={`Линия «${channel.name}»`}
      variant="outline"
      onOpenChange={(open) => {
        if (!open) return;
        setName(channel.name);
        setComment(channel.comment ?? '');
        setLimit(channel.max_concurrent_calls === null ? '' : String(channel.max_concurrent_calls));
      }}
    >
      <DialogForm
        submitLabel="Сохранить"
        canSubmit={name.trim().length >= 2 && limitValid}
        onSubmit={async () => {
          await request(`/client/channels/${channel.id}`, {
            method: 'PATCH',
            body: {
              name: name.trim(),
              comment: comment.trim(),
              maxConcurrentCalls: parsedLimit ?? null,
            },
          });
          await queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
        }}
      >
        <DialogField label="Название" wide>
          <Input
            autoFocus
            maxLength={200}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </DialogField>
        <DialogField label="Комментарий" wide>
          <textarea
            rows={3}
            maxLength={CHANNEL_COMMENT_MAX}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
            className="rounded-md border border-input bg-transparent px-2.5 py-2"
          />
        </DialogField>
        <DialogField
          label="Разговоров одновременно, не больше"
          hint={
            limitValid ? 'Пусто — без предела' : `От 1 до ${String(MAX_CHANNEL_CONCURRENT_CALLS)}`
          }
        >
          <Input
            inputMode="numeric"
            autoComplete="off"
            className="num"
            value={limit}
            aria-invalid={!limitValid}
            onChange={(event) => {
              setLimit(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{children}</dd>
    </>
  );
}

/** Что вписать в программу: секрета здесь нет, пароль — только «Новым паролем» (ADR-0101, п. 7). */
function ConnectionTab({ channel, server }: { channel: Channel; server: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="text-muted-foreground">Сейчас:</span>
        <ConnectionState channel={channel} />
      </p>
      <dl className="grid max-w-xl grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
        <Field label="Сервер">
          <span className="num select-all break-all" translate="no">
            {server}
          </span>
          <CopyButton value={server} label="Скопировать сервер" />
        </Field>
        <Field label="Порт">
          <span className="num">5060 · UDP или TCP</span>
        </Field>
        <Field label="Имя">
          <span className="num select-all break-all" translate="no">
            {channel.sip_username}
          </span>
          <CopyButton value={channel.sip_username} label="Скопировать имя" />
        </Field>
        <Field label="Пароль">
          <span className="text-muted-foreground">
            выдаётся один раз — потерян, нажмите «Новый пароль»
          </span>
        </Field>
        <Field label="Кодеки">
          <span className="num">PCMA, PCMU, G.729</span>
        </Field>
        <Field label="Номер">
          <span>
            <span className="num">+7…</span>, <span className="num">8…</span> или 10 цифр
          </span>
        </Field>
      </dl>
    </div>
  );
}

const SUMMARY_PERIODS = [
  { days: 1, label: 'Сегодня' },
  { days: 7, label: '7 дней' },
] as const;

/** Сводка линии — из того же разреза отчётов, что и «Сводка» кабинета (ADR-0101, п. 9). */
function SummaryTab({ channel }: { channel: Channel }) {
  const today = useBreakdown('/client/reports', 1, 'channel');
  const week = useBreakdown('/client/reports', 7, 'channel');
  const results = [today, week];
  const failed = results.find((result) => result.error !== null)?.error;

  return (
    <div className="flex flex-col gap-3">
      {failed != null && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}
      <div className="max-w-2xl overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Период</TableHead>
              <TableHead className="h-8 text-right">Вызовов</TableHead>
              <TableHead className="h-8 text-right">Отвечено</TableHead>
              <TableHead className="h-8 text-right">Минут</TableHead>
              <TableHead className="h-8 text-right">Потрачено</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SUMMARY_PERIODS.map((period, index) => {
              const rows = results[index]?.data?.rows;
              const row = rows?.find((candidate) => candidate.key === channel.id);
              const share = row === undefined ? undefined : asr(row);
              return (
                <TableRow key={period.days}>
                  <TableCell>{period.label}</TableCell>
                  <TableCell className="num text-right">
                    {rows === undefined ? '…' : (row?.calls ?? 0)}
                  </TableCell>
                  <TableCell className="num text-right">
                    {rows === undefined ? '…' : (row?.answered ?? 0)}
                    {share !== undefined && (
                      <span className="text-faint"> · {Math.round(share)}%</span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">
                    {rows === undefined ? '…' : Math.round((row?.talk_seconds ?? 0) / 60)}
                  </TableCell>
                  <TableCell className="num text-right">
                    {rows === undefined ? '…' : money(row?.spent ?? '0')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap gap-4">
        <Link
          href={`/my/calls?channelId=${channel.id}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          Все вызовы линии
        </Link>
        <Link href="/my/limits" className="text-primary underline-offset-4 hover:underline">
          Лимиты
        </Link>
      </div>
    </div>
  );
}
