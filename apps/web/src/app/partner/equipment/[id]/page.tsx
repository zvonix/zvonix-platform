'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { LineCredentials, type IssuedLines } from '@/components/sip-credentials';
import { Table, TableBody, TableHeader } from '@/components/ui/table';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { GATEWAY_TYPE_NAME } from '@/lib/labels';
import {
  EQUIPMENT_KEY,
  gatewayStateName,
  type Connection,
  type Equipment,
  type Gateway,
  type Sim,
} from '../equipment';
import {
  AddPorts,
  GatewayStatus,
  IssueMissingLines,
  NewPassword,
  RegistrationMode,
} from '../manage';
import { PortHeader, PortRow } from '../ports';

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
  // вместе со строкой порта при обновлении таблицы, а второго показа пароля не будет.
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
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Состояние:</dt>
            <dd>{gatewayStateName(gateway)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Связь с площадкой:</dt>
            <dd className={gateway.on_node ? '' : 'text-warn'}>
              {gateway.on_node ? `есть · ${moment(gateway.registered_at)}` : 'нет'}
            </dd>
          </div>
        </dl>
        <div>
          <GatewayStatus gateway={gateway} />
        </div>
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
      <PortsSection gateway={gateway} spare={equipment.data.spare_sims} onIssued={onIssued} />
    </div>
  );
}

/**
 * Что сделать дальше — одна строка, а не инструкция. Шлюз работает, только когда
 * он включён, на связи и в нём есть включённая карта; первое невыполненное и называется.
 */
function NextStep({ gateway }: { gateway: Gateway }) {
  const sims = gateway.ports.flatMap((port) => (port.sim === null ? [] : [port.sim]));
  const byLine = gateway.registration_mode === 'port';
  const step =
    gateway.status === 'pending'
      ? 'Введите настройки подключения в устройство и включите шлюз.'
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
 * Набор полей зависит от способа подключения (ADR-0054): при входе по линиям у каждой
 * линии свои логин и пароль, при входе на шлюз — один вход и префиксы линий.
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
    <section aria-labelledby="connection" className="flex max-w-[720px] flex-col gap-2">
      <h3 id="connection" className="font-semibold">
        Подключение
      </h3>
      {goip && <RegistrationMode gateway={gateway} onIssued={onIssued} />}
      <p className="text-muted-foreground">
        {goip
          ? 'В веб-интерфейсе GOIP: Configurations → Basic VoIP. Поля названы так же, как там.'
          : 'Эти данные вводятся в настройках SIP самого устройства.'}
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-3">
        {goip && (
          <>
            <dt className="text-muted-foreground">Config Mode</dt>
            <dd>{byLine ? 'Config by Line' : 'Single Server Mode'}</dd>
          </>
        )}
        <dt className="text-muted-foreground">
          {goip ? 'SIP Proxy, SIP Registrar Server' : 'Сервер'}
        </dt>
        <dd className="num select-all">{connection.server}</dd>
        <dt className="text-muted-foreground">Порт</dt>
        <dd className="num select-all">{connection.port}</dd>
        {byLine ? (
          <>
            <dt className="text-muted-foreground">Authentication ID, Phone Number</dt>
            <dd>у каждой линии свой — в таблице портов ниже, столбец «Линия»</dd>
            <dt className="text-muted-foreground">Password</dt>
            <dd>
              показан один раз, при выдаче входа линии. Потеряли — «Новый пароль» у этой линии:
              другие линии это не затронет.
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">
              {goip ? 'Authentication ID, Phone Number' : 'Логин'}
            </dt>
            <dd className="num select-all">{gateway.sip_username}</dd>
            <dt className="text-muted-foreground">{goip ? 'Password' : 'Пароль'}</dt>
            <dd>
              показан один раз, при добавлении шлюза. Потеряли — выдайте новый: старые логин и
              пароль перестанут работать.
            </dd>
          </>
        )}
        {goip && !byLine && (
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
      {goip && byLine && (
        <p className="text-muted-foreground">
          Площадка звонит в ту линию, где стоит карта нужного оператора, её собственным входом.
          Чтобы проверить одну SIM, настройте в GOIP только её линию и вставьте в кабинете только
          её.
        </p>
      )}
      {goip && !byLine && (
        <p className="text-muted-foreground">
          По префиксу GOIP понимает, с какой SIM звонить: площадка выбирает карту нужного оператора
          и набирает номер с префиксом её линии. Звонит площадка только через карты, вставленные в
          порты здесь, — чтобы проверить одну SIM, вставьте в кабинете только её.
        </p>
      )}
      {byLine ? (
        <IssueMissingLines gateway={gateway} onIssued={onIssued} />
      ) : (
        <NewPassword gateway={gateway} />
      )}
    </section>
  );
}

function PortsSection({
  gateway,
  spare,
  onIssued,
}: {
  gateway: Gateway;
  spare: readonly Sim[];
  onIssued: (issued: IssuedLines) => void;
}) {
  return (
    <section aria-labelledby="ports" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="ports" className="font-semibold">
          Порты
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
                <PortRow
                  key={port.id}
                  gateway={gateway}
                  port={port}
                  spare={spare}
                  onIssued={onIssued}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
