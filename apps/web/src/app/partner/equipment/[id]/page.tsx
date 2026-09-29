'use client';

import { useQuery } from '@tanstack/react-query';
import { goipLinePrefix } from '@zvonix/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { LineCredentials, type IssuedLines } from '@/components/sip-credentials';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { GATEWAY_TYPE_NAME } from '@/lib/labels';
import {
  EQUIPMENT_KEY,
  PARTNER_BLOCKED,
  usePartnerStatus,
  type Connection,
  type Equipment,
  type Gateway,
  type Sim,
} from '../equipment';
import {
  AddPorts,
  GatewayStatus,
  IssueMissingLines,
  NewLineAccount,
  NewPassword,
  RegistrationMode,
} from '../manage';
import { PortHeader, PortRow, Presence } from '../ports';

export default function PartnerGatewayPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConsoleShell title="Шлюз" cabinet="partner">
      {() => <GatewayCard id={params.id} />}
    </ConsoleShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/partner/equipment"
      className="self-start text-primary underline-offset-4 hover:underline"
    >
      ← Всё оборудование
    </Link>
  );
}

/**
 * Страница шлюза: подключение и порты
 * ([DESIGN.md](../../../../../../../docs/DESIGN.md), «Окно, страница или панель»).
 *
 * Отдельного обработчика нет: шлюз берётся из того же ответа `GET /partner/equipment`,
 * что и список, — без портов и свободных карт он не значит ничего, а свободные карты
 * нужны, чтобы вставить их в порт.
 */
function GatewayCard({ id }: { id: string }) {
  const equipment = useQuery({
    queryKey: EQUIPMENT_KEY,
    queryFn: () => request<Equipment>('/partner/equipment'),
  });
  // Выданные входы линий живут здесь, над разделами: панель не должна пропадать
  // вместе со строкой при обновлении таблицы, а второго показа пароля не будет.
  const [issued, setIssued] = useState<readonly IssuedLines[]>([]);
  const onIssued = (lines: IssuedLines): void => {
    setIssued((list) => [...list, lines]);
  };

  if (equipment.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  if (equipment.data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p role="alert" className="text-crit">
          {equipment.error.message}
        </p>
      </div>
    );
  }

  const gateway = equipment.data.gateways.find((row) => row.id === id);
  if (gateway === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p>Такого шлюза нет — возможно, он удалён. Остальное оборудование — в общем списке.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">{gateway.name}</h2>
          <span className="text-muted-foreground">
            {GATEWAY_TYPE_NAME[gateway.type]}
            {gateway.model !== null && ` · ${gateway.model}`}
          </span>
        </div>
        <GatewayStatus gateway={gateway} />
        <p>
          <span className="text-muted-foreground">Связь с площадкой: </span>
          <span className={gateway.on_node ? '' : 'text-warn'}>
            {gateway.on_node ? `есть · ${moment(gateway.registered_at)}` : 'нет'}
          </span>
        </p>
        <NextStep gateway={gateway} />
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

      <ConnectionSection
        gateway={gateway}
        connection={equipment.data.connection}
        onIssued={onIssued}
      />
      <PortsSection gateway={gateway} spare={equipment.data.spare_sims} />
    </div>
  );
}

/**
 * Что сделать дальше — одна строка, а не инструкция. Шлюз работает, только когда
 * он включён, на связи и в нём есть включённая карта; первое невыполненное и называется.
 *
 * Невключённый шлюз площадка не пускает вовсе, даже с верными настройками, — и это
 * говорится первым: партнёр настроил GOIP и ждал связи, не зная, что шлюз не включён
 * (владелец, 2026-09-25).
 */
function NextStep({ gateway }: { gateway: Gateway }) {
  const partnerStatus = usePartnerStatus();
  // Партнёр не допущен — главное и единственное, что стоит сказать: остальные советы
  // уведут искать ошибку в устройстве.
  if (partnerStatus !== undefined && partnerStatus !== 'verified') {
    return <p className="text-warn">{PARTNER_BLOCKED[partnerStatus]}</p>;
  }
  const sims = gateway.ports.flatMap((port) => (port.sim === null ? [] : [port.sim]));
  const byLine = gateway.registration_mode === 'port';
  const off =
    gateway.status === 'pending' ||
    (gateway.status === 'suspended' && gateway.suspended_by === 'partner');
  const step = off
    ? `Шлюз не включён — ${byLine ? 'линии не могут' : 'устройство не может'} подключиться к площадке даже с верными настройками. Введите настройки в устройство и нажмите «Включить шлюз».`
    : gateway.status === 'active' && !gateway.on_node
      ? byLine
        ? 'Шлюз включён, но ни одна линия не на связи: проверьте в GOIP сервер, логины и пароли линий.'
        : 'Шлюз включён, но не на связи: проверьте в устройстве сервер, логин и пароль ниже.'
      : sims.length === 0
        ? 'Вставьте SIM-карты в порты — без них вызовов не будет.'
        : !sims.some((sim) => sim.status === 'active')
          ? 'Включите карты в портах — выключенные вызовов не получают.'
          : undefined;
  if (step === undefined) return null;
  return <p className="text-warn">{step}</p>;
}

/**
 * Куда и под каким именем регистрировать устройство. Пароль — только при выдаче.
 *
 * Названия полей — как в веб-интерфейсе GOIP (раздел Configurations → Basic VoIP):
 * партнёр переносит значения построчно, и переводить английские подписи в уме ему незачем.
 * Набор полей зависит от способа подключения (ADR-0054): при входе на шлюз — один вход
 * и префиксы линий, при входе по линиям — таблица «что ввести в каждую линию».
 */
function ConnectionSection({
  gateway,
  connection,
  onIssued,
}: {
  gateway: Gateway;
  connection: Connection;
  onIssued: (issued: IssuedLines) => void;
}) {
  const goip = gateway.type === 'goip';
  const byLine = gateway.registration_mode === 'port';
  return (
    <section aria-labelledby="connection" className="flex flex-col gap-2">
      <h3 id="connection" className="font-semibold">
        Подключение
      </h3>
      {goip && <RegistrationMode gateway={gateway} onIssued={onIssued} />}
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
    </section>
  );
}

/** Один вход на весь шлюз: сервер, логин, пароль и, у GOIP, префиксы линий. */
function GatewaySettings({ gateway, connection }: { gateway: Gateway; connection: Connection }) {
  const goip = gateway.type === 'goip';
  return (
    <div className="flex max-w-[720px] flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-3">
        {goip && (
          <>
            <dt className="text-muted-foreground">Config Mode</dt>
            <dd>Single Server Mode</dd>
          </>
        )}
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
            <dt className="text-muted-foreground">Prefix Match Mode</dt>
            <dd>Match Callee</dd>
            <dt className="text-muted-foreground">Delete Callee Prefix while Dialing</dt>
            <dd>Enable</dd>
            <dt className="text-muted-foreground">Line N Routing Prefix</dt>
            <dd>префикс из таблицы портов ниже — у каждой линии свой</dd>
          </>
        )}
      </dl>
      {goip && (
        <p className="text-muted-foreground">
          По префиксу GOIP понимает, с какой SIM звонить: площадка выбирает карту нужного оператора
          и набирает номер с префиксом её линии. Звонит площадка только через карты, вставленные в
          порты здесь, — чтобы проверить одну SIM, вставьте в кабинете только её.
        </p>
      )}
      <NewPassword gateway={gateway} />
    </div>
  );
}

/**
 * Что ввести в GOIP при входе по линиям — **полем в поле, как на странице Basic VoIP**
 * ([ADR-0054](../../../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
 *
 * Раньше здесь были только логин, сервер и порт, и партнёр, введя всё показанное, получал
 * GOIP, который не набирает номер: без Routing Prefix линия принимает звонок площадки как
 * двухступенчатый и ждёт тонового набора (владелец, 2026-09-29: «там нет ничего про префикс
 * и про Config Mode»). Теперь — общие поля одним блоком в порядке страницы GOIP и таблица
 * того, что у линий разное; ни одно поле, которое надо трогать, не остаётся за кадром.
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
      <div className="flex max-w-[720px] flex-col gap-2">
        <p className="text-muted-foreground">
          Configurations → Basic VoIP. Сначала общее — одинаково у всех линий:
        </p>
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
      </div>

      <p className="max-w-[720px] text-muted-foreground">
        Потом каждая линия (Line 1, Line 2…) — по строке таблицы.{' '}
        <span className="text-foreground">Routing Prefix обязателен</span>: по нему GOIP понимает,
        что звонок площадки нужно набрать с этой линии; без него линия ждёт номер тоновым набором и
        звонки не проходят.
      </p>
      <IssueMissingLines gateway={gateway} onIssued={onIssued} />
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
                <TableCell className="num select-all">{goipLinePrefix(port.port_number)}</TableCell>
                <TableCell className="num">
                  {port.sip_username === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <span className="text-muted-foreground">как Authentication ID</span>
                  )}
                </TableCell>
                <TableCell>
                  <Presence
                    online={port.on_node}
                    title={port.on_node ? `отметка ${moment(port.registered_at)}` : undefined}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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

function PortsSection({ gateway, spare }: { gateway: Gateway; spare: readonly Sim[] }) {
  return (
    <section aria-labelledby="ports" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="ports" className="font-semibold">
          Порты и SIM-карты
        </h3>
        <AddPorts gateway={gateway} />
      </div>

      {gateway.ports.length === 0 ? (
        <p className="text-muted-foreground">
          Портов нет — добавьте столько, сколько слотов под SIM на корпусе.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <PortHeader />
            </TableHeader>
            <TableBody>
              {gateway.ports.map((port) => (
                <PortRow key={port.id} gateway={gateway} port={port} spare={spare} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
