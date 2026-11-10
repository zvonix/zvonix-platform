'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ConsoleShell } from '@/components/console-shell';
import { Presence } from '@/components/presence';
import { useTariffName } from '@/components/tariff-select';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableHeader } from '@/components/ui/table';
import { GATEWAY_TYPE_NAME } from '@/lib/labels';
import { PARTNER_BLOCKED, usePartnerStatus, type Gateway, type Sim } from '../equipment';
import { GatewayStatus } from '../manage';
import { PoorConnection, PortHeader, PortRow } from '../ports';
import { connectLabel, GatewayLoader } from './gateway-loader';

/**
 * Страница шлюза — то, с чем партнёр работает каждый день: состояние шлюза и его линии
 * с картами ([DESIGN.md](../../../../../../../docs/DESIGN.md), «Страница объекта: что где лежит»).
 *
 * Настройки самого шлюза — своей страницей по кнопке «Настройки», что ввести в устройство —
 * страницей «Подключение». Раньше всё это было одним полотном: поля GOIP, таблица входов
 * линий, тариф и таблица портов подряд, одни и те же линии — в двух таблицах, а название
 * и модель после добавления поменять было нельзя вовсе (владелец, 2026-11-10).
 */
export default function PartnerGatewayPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConsoleShell title="Шлюз" cabinet="partner">
      {() => (
        <GatewayLoader
          id={params.id}
          back={{ href: '/partner/equipment', label: 'Всё оборудование' }}
        >
          {({ gateway, equipment }) => (
            <>
              <GatewayHeader gateway={gateway} />
              <LinesSection gateway={gateway} spare={equipment.spare_sims} />
            </>
          )}
        </GatewayLoader>
      )}
    </ConsoleShell>
  );
}

function GatewayHeader({ gateway }: { gateway: Gateway }) {
  const nameOf = useTariffName();
  const tariff = nameOf(gateway.tariff_id) ?? nameOf(null);
  // Пока шлюз не на связи, главное — подключить устройство: эта кнопка и выделена.
  const connecting = !gateway.connection.connected;
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{gateway.name}</h2>
        <span className="text-muted-foreground">
          {GATEWAY_TYPE_NAME[gateway.type]}
          {gateway.model !== null && ` · ${gateway.model}`}
        </span>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <GatewayStatus gateway={gateway} />
        <Button asChild size="sm" variant={connecting ? 'default' : 'outline'}>
          <Link href={`/partner/equipment/${gateway.id}/connect`}>{connectLabel(gateway)}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/partner/equipment/${gateway.id}/settings`}>Настройки</Link>
        </Button>
      </div>
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">Связь с площадкой:</span>
        <Presence connection={gateway.connection} />
        {gateway.connection.connected && gateway.connection.address !== null && (
          <span className="num text-muted-foreground">{gateway.connection.address}</span>
        )}
        {gateway.poor_connection === true && <PoorConnection />}
        {tariff !== undefined && (
          <>
            <span className="text-faint">·</span>
            <span className="text-muted-foreground">Тариф:</span>
            <span>{tariff}</span>
          </>
        )}
      </p>
      <NextStep gateway={gateway} />
    </header>
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
  const where = `«${connectLabel(gateway)}»`;
  const off =
    gateway.status === 'pending' ||
    (gateway.status === 'suspended' && gateway.suspended_by === 'partner');
  const step =
    gateway.ports.length === 0
      ? 'У шлюза нет линий — укажите их число в настройках.'
      : off
        ? `Шлюз не включён — ${byLine ? 'линии не могут' : 'устройство не может'} подключиться к площадке даже с верными настройками. Введите настройки из ${where} в устройство и нажмите «Включить шлюз».`
        : gateway.status === 'active' && !gateway.connection.connected
          ? gateway.connection.rejected
            ? byLine
              ? `Линии обращаются к площадке, но не входят: в GOIP неверный логин или пароль линии. Сверьте их на странице ${where}.`
              : `Устройство обращается к площадке, но не входит: в нём неверный логин или пароль. Сверьте их на странице ${where}.`
            : byLine
              ? `Шлюз включён, но ни одна линия не на связи: проверьте в GOIP сервер, логины и пароли линий — страница ${where}.`
              : `Шлюз включён, но не на связи: проверьте в устройстве сервер, логин и пароль — страница ${where}.`
          : sims.length === 0
            ? 'Вставьте SIM-карты в линии — без них вызовов не будет.'
            : !sims.some((sim) => sim.status === 'active')
              ? 'Включите карты в линиях — выключенные вызовов не получают.'
              : undefined;
  if (step === undefined) return null;
  return <p className="max-w-[720px] text-warn">{step}</p>;
}

/** Линии и карты в них — одна таблица: здесь вставляют и вынимают SIM и видят, кто на связи. */
function LinesSection({ gateway, spare }: { gateway: Gateway; spare: readonly Sim[] }) {
  return (
    <section aria-labelledby="lines" className="flex flex-col gap-2">
      <h3 id="lines" className="font-semibold">
        Линии и SIM-карты
      </h3>
      {gateway.ports.length === 0 ? (
        <p className="text-muted-foreground">
          Линий нет. Число линий — в{' '}
          <Link href={`/partner/equipment/${gateway.id}/settings`}>настройках шлюза</Link>: столько,
          сколько слотов под SIM на корпусе.
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
