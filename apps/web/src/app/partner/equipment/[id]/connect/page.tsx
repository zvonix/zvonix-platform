'use client';

import { goipLinePrefix } from '@zvonix/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Presence } from '@/components/presence';
import { CopyButton } from '@/components/copy-button';
import { LineCredentials, type IssuedLines } from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { REGISTRATION_MODE_NAME } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import type { Connection, Gateway, Port } from '../../equipment';
import { IssueMissingLines, NewLineAccount, NewPassword } from '../../manage';
import { connectLabel, GatewayLoader } from '../gateway-loader';

/**
 * Что ввести в устройство — разовая инструкция, своей страницей
 * ([DESIGN.md](../../../../../../../../docs/DESIGN.md), «Страница объекта: что где лежит»).
 *
 * Названия полей — как в веб-интерфейсе GOIP (раздел Configurations → Basic VoIP):
 * партнёр переносит значения построчно, и переводить английские подписи в уме ему незачем.
 * Набор полей зависит от способа подключения (ADR-0054): при входе на шлюз — один вход
 * и префиксы линий, при входе по линиям — таблица «что ввести в каждую линию». Сам способ
 * меняется в настройках шлюза: это настройка, а не шаг инструкции.
 */
export default function PartnerGatewayConnectPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConsoleShell title="Подключение шлюза" cabinet="partner">
      {() => (
        <GatewayLoader
          id={params.id}
          back={{ href: `/partner/equipment/${params.id}`, label: 'К шлюзу' }}
        >
          {({ gateway, equipment }) => (
            <ConnectionPage gateway={gateway} connection={equipment.connection} />
          )}
        </GatewayLoader>
      )}
    </ConsoleShell>
  );
}

function ConnectionPage({ gateway, connection }: { gateway: Gateway; connection: Connection }) {
  // Выданные входы линий живут здесь, над таблицей: панель не должна пропадать вместе
  // со строкой при обновлении таблицы, а второго показа пароля не будет.
  const [issued, setIssued] = useState<readonly IssuedLines[]>([]);
  const onIssued = (lines: IssuedLines): void => {
    setIssued((list) => [...list, lines]);
  };
  const goip = gateway.type === 'goip';
  const byLine = gateway.registration_mode === 'port';

  return (
    <>
      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">
          {connectLabel(gateway)}: {gateway.name}
        </h2>
        <p className="flex flex-wrap items-center gap-x-2">
          <span className="text-muted-foreground">Связь с площадкой:</span>
          <Presence connection={gateway.connection} />
        </p>
        {goip && (
          <p className="text-muted-foreground">
            Способ подключения:{' '}
            <span className="text-foreground">
              {REGISTRATION_MODE_NAME[gateway.registration_mode]}
            </span>{' '}
            · меняется в{' '}
            <Link href={`/partner/equipment/${gateway.id}/settings`}>настройках шлюза</Link>
          </p>
        )}
      </header>

      {issued.map((secret) => (
        <LineCredentials
          key={secret.lines[0]?.username ?? secret.title}
          lines={secret.lines}
          title={secret.title}
          onClose={() => {
            setIssued((list) => list.filter((item) => item !== secret));
          }}
        />
      ))}

      <p className="max-w-[720px] text-muted-foreground">
        {goip
          ? 'В веб-интерфейсе GOIP: Configurations → Basic VoIP. Поля названы так же, как там.'
          : 'Эти данные вводятся в настройках SIP самого устройства.'}
      </p>
      {connection.server === null ? (
        <p role="alert" className="max-w-[720px] text-warn">
          Площадка ещё не задала адрес для подключения: узел АТС, куда GOIP должен регистрироваться,
          не настроен. Вводить настройки в устройство пока незачем — напишите в поддержку.
        </p>
      ) : byLine ? (
        <LineSettings
          gateway={gateway}
          connection={{ ...connection, server: connection.server }}
          onIssued={onIssued}
        />
      ) : (
        <GatewaySettings
          gateway={gateway}
          connection={{ ...connection, server: connection.server }}
        />
      )}
    </>
  );
}

/** Один вход на весь шлюз: сервер, логин, пароль и, у GOIP, префиксы линий. */
/** Подключение, у которого адрес есть: поля GOIP показываются только с ним. */
type KnownConnection = Connection & { readonly server: string };

function GatewaySettings({
  gateway,
  connection,
}: {
  gateway: Gateway;
  connection: KnownConnection;
}) {
  const goip = gateway.type === 'goip';
  return (
    <div className="flex max-w-[720px] flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-3">
        {goip && <GoipField name="Config Mode" value="Single Server Mode" />}
        <dt className="text-muted-foreground">
          {goip ? 'SIP Proxy, SIP Registrar Server' : 'Сервер'}
        </dt>
        <dd className="flex items-center gap-1">
          <span className="num select-all">{connection.server}</span>
          <CopyButton value={connection.server} label="Скопировать адрес" />
        </dd>
        <dt className="text-muted-foreground">Порт</dt>
        <dd className="num select-all">{connection.port}</dd>
        <dt className="text-muted-foreground">
          {goip ? 'Authentication ID, Phone Number' : 'Логин'}
        </dt>
        <dd className="flex items-center gap-1">
          <span className="num select-all">{gateway.sip_username}</span>
          <CopyButton value={gateway.sip_username} label="Скопировать логин" />
        </dd>
        <dt className="text-muted-foreground">{goip ? 'Password' : 'Пароль'}</dt>
        <dd>
          показан один раз, при добавлении шлюза. Потеряли — выдайте новый: старые логин и пароль
          перестанут работать.
        </dd>
        {goip && (
          <>
            <GoipField name="Prefix Match Mode" value="Match Callee" />
            <GoipField name="Delete Callee Prefix while Dialing" value="Enable" />
          </>
        )}
      </dl>
      {goip && gateway.ports.length > 0 && (
        <>
          <p className="text-muted-foreground">
            И у каждой линии — свой Routing Prefix: по нему GOIP понимает, с какой SIM звонить.
          </p>
          <div className="max-w-sm overflow-x-auto rounded-lg border border-border bg-card">
            <Table aria-label="Префиксы линий" className="whitespace-nowrap">
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Линия</TableHead>
                  <TableHead className="h-8">Routing Prefix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gateway.ports.map((port) => (
                  <TableRow key={port.id}>
                    <TableCell className="num">Line {port.port_number}</TableCell>
                    <TableCell>
                      <span className="num select-all">{goipLinePrefix(port.port_number)}</span>
                      <CopyButton
                        value={goipLinePrefix(port.port_number)}
                        label={`Скопировать Routing Prefix линии ${String(port.port_number)}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <NewPassword gateway={gateway} />
    </div>
  );
}

/**
 * Что ввести в GOIP при входе по линиям — двумя шагами
 * ([ADR-0054](../../../../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
 *
 * Шаг 1 — общее для всех линий, вводится один раз; когда хоть одна линия на связи, он свёрнут.
 * Шаг 2 — **одна линия за раз**: выбор линии и только её поля, каждое с копированием. Раньше всё было
 * одной страницей — общие поля и таблица всех линий с паролями подряд (владелец, 2026-11-11: «настройки
 * и для общей, и для каждой линии все опять в куче»). Выбранная линия живёт в адресе (`?line=3`).
 *
 * Без Routing Prefix линия принимает звонок площадки как двухступенчатый и ждёт тонового набора
 * (владелец, 2026-09-29) — поэтому префикс стоит в поле линии, а не в пояснении.
 */
function LineSettings({
  gateway,
  connection,
  onIssued,
}: {
  gateway: Gateway;
  connection: KnownConnection;
  onIssued: (issued: IssuedLines) => void;
}) {
  const url = useUrlState();
  // Порт 5060 у GOIP по умолчанию и отдельно не вводится; другой — пишется через двоеточие.
  const proxy =
    connection.port === 5060
      ? connection.server
      : `${connection.server}:${String(connection.port)}`;
  const portNote =
    connection.port === 5060 ? 'порт 5060 — по умолчанию, отдельно не вводится' : undefined;
  const anyConnected = gateway.ports.some((port) => port.connection.connected);
  const selected =
    gateway.ports.find((port) => String(port.port_number) === url.get('line')) ?? gateway.ports[0];

  return (
    <div className="flex flex-col gap-4">
      <details
        open={!anyConnected}
        className="max-w-[720px] rounded-lg border border-border bg-card"
      >
        <summary className="cursor-pointer p-3 font-semibold">
          Шаг 1. Общие настройки — вводятся один раз, одинаковы у всех линий
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <GoipField name="Config Mode" value="Config by Line" />
            <GoipField name="SIP Proxy" value={proxy} copy note={portNote} />
            <GoipField name="SIP Registrar" value={proxy} copy note={portNote} />
            <GoipField name="Re-register Period (s)" value="60" />
            <GoipField name="Outbound Proxy" value="пусто" empty />
            <GoipField name="Home Domain" value="пусто" empty />
            <GoipField name="Backup Server" value="Disable" />
            <GoipField name="Prefix Match Mode" value="Match Callee" />
            <GoipField name="Delete Callee Prefix while Dialing" value="Enable" />
          </dl>
          <p className="text-muted-foreground">
            И на странице Configurations → Call Out:{' '}
            <span className="text-foreground">Call OUT via GSM — Enable</span>, Dial Plan — пусто.
          </p>
        </div>
      </details>

      <section aria-labelledby="per-line" className="flex max-w-[720px] flex-col gap-3">
        <h3 id="per-line" className="font-semibold">
          Шаг 2. Линии — каждая отдельно
        </h3>
        <IssueMissingLines gateway={gateway} onIssued={onIssued} />
        {selected === undefined ? (
          <p className="text-muted-foreground">
            Линий нет — укажите их число в{' '}
            <Link href={`/partner/equipment/${gateway.id}/settings`}>настройках шлюза</Link>.
          </p>
        ) : (
          <>
            <div role="group" aria-label="Линия" className="flex flex-wrap gap-1.5">
              {gateway.ports.map((port) => {
                const current = port.id === selected.id;
                return (
                  <Button
                    key={port.id}
                    type="button"
                    size="sm"
                    variant={current ? 'default' : 'outline'}
                    aria-pressed={current}
                    onClick={() => {
                      url.set({ line: String(port.port_number) });
                    }}
                  >
                    <span
                      aria-hidden
                      className={`size-2 rounded-full ${port.connection.connected ? 'bg-ok' : 'bg-warn'}`}
                    />
                    Line {port.port_number}
                    <span className="sr-only">
                      {port.connection.connected ? ' — на связи' : ' — не на связи'}
                    </span>
                  </Button>
                );
              })}
            </div>
            <LineCard gateway={gateway} port={selected} onIssued={onIssued} />
          </>
        )}
      </section>
    </div>
  );
}

/** Поля одной линии — ровно то, что вводится в Line N на странице Basic VoIP. */
function LineCard({
  gateway,
  port,
  onIssued,
}: {
  gateway: Gateway;
  port: Port;
  onIssued: (issued: IssuedLines) => void;
}) {
  const prefix = goipLinePrefix(port.port_number);
  return (
    <section
      aria-label={`Line ${String(port.port_number)}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="num font-semibold">Line {port.port_number}</span>
        <Presence connection={port.connection} />
        {port.sim !== null && (
          <span className="num text-muted-foreground">· SIM {port.sim.msisdn}</span>
        )}
      </p>
      {port.sip_username === null ? (
        <p className="text-warn">
          У линии ещё нет входа — выдайте его кнопкой выше, пароль покажут один раз.
        </p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1">
          <CopyField name="Authentication ID" value={port.sip_username} />
          <dt className="text-muted-foreground">Password</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">показан один раз, при выдаче</span>
            <NewLineAccount gateway={gateway} port={port} onIssued={onIssued} />
          </dd>
          <CopyField name="Phone Number" value={port.sip_username} />
          <CopyField name="Routing Prefix" value={prefix} />
        </dl>
      )}
    </section>
  );
}

/** Поле линии со значением и кнопкой копирования: переносить в GOIP строку за строкой. */
function CopyField({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="flex items-center gap-1">
        <span className="num select-all">{value}</span>
        <CopyButton value={value} label={`Скопировать ${name}`} />
      </dd>
    </>
  );
}

/** Поле страницы GOIP: название как в устройстве, значение — что туда ввести. */
function GoipField({
  name,
  value,
  copy = false,
  empty = false,
  note,
}: {
  name: string;
  value: string;
  copy?: boolean;
  empty?: boolean;
  /** Пояснение серым после значения — не копируется вместе с ним. */
  note?: string | undefined;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd>
        <span className={`${copy ? 'num select-all' : ''} ${empty ? 'text-faint' : ''}`}>
          {value}
        </span>
        {note !== undefined && <span className="text-muted-foreground"> · {note}</span>}
      </dd>
    </>
  );
}
