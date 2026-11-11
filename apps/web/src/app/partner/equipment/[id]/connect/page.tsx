'use client';

import { goipLinePrefix } from '@zvonix/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Presence } from '@/components/presence';
import { LineCredentials, type IssuedLines } from '@/components/sip-credentials';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { REGISTRATION_MODE_NAME } from '@/lib/labels';
import type { Connection, Gateway } from '../../equipment';
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
      {byLine ? (
        <LineSettings gateway={gateway} connection={connection} onIssued={onIssued} />
      ) : (
        <GatewaySettings gateway={gateway} connection={connection} />
      )}
    </>
  );
}

/** Один вход на весь шлюз: сервер, логин, пароль и, у GOIP, префиксы линий. */
function GatewaySettings({ gateway, connection }: { gateway: Gateway; connection: Connection }) {
  const goip = gateway.type === 'goip';
  return (
    <div className="flex max-w-[720px] flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-3">
        {goip && <GoipField name="Config Mode" value="Single Server Mode" />}
        <dt className="text-muted-foreground">
          {goip ? 'SIP Proxy, SIP Registrar Server' : 'Сервер'}
        </dt>
        <dd className="num select-all">{connection.server}</dd>
        <dt className="text-muted-foreground">Порт</dt>
        <dd className="num select-all">{connection.port}</dd>
        <dt className="text-muted-foreground">
          {goip ? 'Authentication ID, Phone Number' : 'Логин'}
        </dt>
        <dd className="num select-all">{gateway.sip_username}</dd>
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
                    <TableCell className="num select-all">
                      {goipLinePrefix(port.port_number)}
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
 * Что ввести в GOIP при входе по линиям — **полем в поле, как на странице Basic VoIP**
 * ([ADR-0054](../../../../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
 *
 * Без Routing Prefix линия принимает звонок площадки как двухступенчатый и ждёт тонового
 * набора (владелец, 2026-09-29: «там нет ничего про префикс и про Config Mode»). Поэтому —
 * общие поля одним блоком в порядке страницы GOIP и таблица того, что у линий разное.
 */
function LineSettings({
  gateway,
  connection,
  onIssued,
}: {
  gateway: Gateway;
  connection: Connection;
  onIssued: (issued: IssuedLines) => void;
}) {
  // Порт 5060 у GOIP по умолчанию и отдельно не вводится; другой — пишется через двоеточие.
  const proxy =
    connection.port === 5060
      ? connection.server
      : `${connection.server}:${String(connection.port)}`;
  const portNote =
    connection.port === 5060 ? 'порт 5060 — по умолчанию, отдельно не вводится' : undefined;
  return (
    <div className="flex flex-col gap-3">
      <section aria-labelledby="common" className="flex max-w-[720px] flex-col gap-2">
        <h3 id="common" className="font-semibold">
          1. Общее — одинаково у всех линий
        </h3>
        <p className="text-muted-foreground">Configurations → Basic VoIP:</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-3">
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
      </section>

      <section aria-labelledby="per-line" className="flex flex-col gap-2">
        <h3 id="per-line" className="font-semibold">
          2. Каждая линия — по строке таблицы
        </h3>
        <p className="max-w-[720px] text-muted-foreground">
          <span className="text-foreground">Routing Prefix обязателен</span>: по нему GOIP понимает,
          что звонок площадки нужно набрать с этой линии; без него линия ждёт номер тоновым набором
          и звонки не проходят. Число линий меняется в{' '}
          <Link href={`/partner/equipment/${gateway.id}/settings`}>настройках шлюза</Link>.
        </p>
        <IssueMissingLines gateway={gateway} onIssued={onIssued} />
        {gateway.ports.length === 0 ? (
          <p className="text-muted-foreground">Линий нет — укажите их число в настройках шлюза.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table aria-label="Настройки линий" className="whitespace-nowrap">
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Линия</TableHead>
                  <TableHead className="h-8">Authentication ID</TableHead>
                  <TableHead className="h-8">Password</TableHead>
                  <TableHead className="h-8">Routing Prefix</TableHead>
                  <TableHead className="h-8">Phone Number</TableHead>
                  <TableHead className="h-8">Связь</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gateway.ports.map((port) => (
                  <TableRow key={port.id}>
                    <TableCell className="num">Line {port.port_number}</TableCell>
                    <TableCell className="num select-all">
                      {port.sip_username ?? <span className="text-warn">вход не выдан</span>}
                    </TableCell>
                    <TableCell>
                      {port.sip_username !== null && (
                        <span className="flex items-center gap-2">
                          <span className="text-muted-foreground">показан при выдаче</span>
                          <NewLineAccount gateway={gateway} port={port} onIssued={onIssued} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="num select-all">
                      {goipLinePrefix(port.port_number)}
                    </TableCell>
                    <TableCell className="num">
                      {port.sip_username === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className="text-muted-foreground">как Authentication ID</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Presence connection={port.connection} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
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
