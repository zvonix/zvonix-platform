'use client';

import { useQuery } from '@tanstack/react-query';
import { LiveSwitch } from '@/components/live-switch';
import { useLiveInterval } from '@/lib/live';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { GATEWAY_TYPE_NAME, REGISTRATION_MODE_NAME } from '@/lib/labels';
import { ROW_ICON, RowActions } from '@/components/table-parts';
import { StatusDot } from '@/components/status-dot';
import { Tooltip } from '@/components/ui/tooltip';
import {
  EQUIPMENT_KEY,
  gatewayStateName,
  PARTNER_BLOCKED,
  usePartnerStatus,
  type Equipment,
  type Gateway,
  type Sim,
} from './equipment';
import { AddGateway, SimActions, SimSwitch } from './manage';
import { AddTrunk, TrunksSection } from './trunks';
import { Presence } from '@/components/presence';
import { PORT_COLUMNS, PoorConnection, PortHeader, PortRow, SimStateCell } from './ports';

export default function PartnerEquipmentPage() {
  return (
    <ConsoleShell title="Оборудование" cabinet="partner">
      {() => <PartnerEquipment />}
    </ConsoleShell>
  );
}

/**
 * Оборудование одной таблицей: строка шлюза и под ней его порты с картами
 * ([ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md), «Кабинет»).
 * Раньше карты были видны только на странице каждого шлюза, и чтобы найти, где стоит
 * номер, приходилось заходить во все по очереди (владелец, 2026-09-25). Страница шлюза
 * осталась для подключения — сервера, входов и способа подключения.
 */
function PartnerEquipment() {
  const live = useLiveInterval();
  const equipment = useQuery({
    queryKey: EQUIPMENT_KEY,
    queryFn: () => request<Equipment>('/partner/equipment'),
    refetchInterval: live,
  });
  const partnerStatus = usePartnerStatus();

  if (equipment.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  // Ранний выход — только когда показывать нечего: неудачное фоновое обновление
  // не должно размонтировать панель с только что выданным паролем SIP.
  if (equipment.data === undefined) {
    return (
      <p role="alert" className="text-crit">
        {equipment.error.message}
      </p>
    );
  }

  const { gateways, trunks, spare_sims: spare } = equipment.data;
  const offline = gateways.filter(
    (gateway) => gateway.status === 'active' && !gateway.connection.connected,
  );

  return (
    <div className="flex flex-col gap-4">
      {equipment.error !== null && (
        <p role="alert" className="text-crit">
          Не удалось обновить оборудование: {equipment.error.message}. Показано последнее
          загруженное.
        </p>
      )}

      {/*
        Самое дорогое из невидимого: включённый шлюз без регистрации выглядит рабочим
        в любом списке, но вызов на него не уйдёт вовсе — набрать его с узла нечем.
      */}
      {partnerStatus !== undefined && partnerStatus !== 'verified' && (
        <p role="status" className="max-w-[860px] text-warn">
          {PARTNER_BLOCKED[partnerStatus]}
        </p>
      )}

      {/* Пока партнёр не допущен, «проверьте настройки» увело бы искать не там. */}
      {offline.length > 0 && partnerStatus === 'verified' && (
        <p className="text-warn">
          {offline.length === 1
            ? 'Шлюз не на связи'
            : `Шлюзов не на связи: ${String(offline.length)}`}{' '}
          — вызовы на {offline.length === 1 ? 'него' : 'них'} не идут.{' '}
          {offline.every((gateway) => gateway.connection.rejected)
            ? 'Устройство обращается, но не входит — сверьте логин и пароль на странице шлюза.'
            : 'Проверьте питание, сеть и настройки подключения на странице шлюза.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <AddGateway />
        <AddTrunk />
        <div className="ml-auto">
          <LiveSwitch />
        </div>
      </div>

      {gateways.length === 0 && trunks.length === 0 ? (
        <div className="flex max-w-prose flex-col gap-1 text-muted-foreground">
          <p>Оборудования пока нет. Порядок такой:</p>
          <ol className="list-decimal pl-5">
            <li>Добавьте шлюз — порты под SIM появятся сразу.</li>
            <li>Введите в настройках устройства сервер, логин и пароль со страницы шлюза.</li>
            <li>Вставьте SIM-карты в порты и включите шлюз.</li>
          </ol>
          <p>Есть SIP-провайдер — добавьте его, проверьте тестовым звонком и включите.</p>
        </div>
      ) : (
        gateways.length > 0 && <GatewaysTable gateways={gateways} spare={spare} />
      )}

      {trunks.length > 0 && <TrunksSection trunks={trunks} />}

      {spare.length > 0 && (
        <section aria-labelledby="spare" className="flex flex-col gap-2">
          <h3 id="spare" className="font-semibold">
            Карты вне шлюзов
          </h3>
          <p className="max-w-prose text-muted-foreground">
            Вынутые из портов карты вызовов не получают. Вставить такую карту можно значком «+» у
            пустого порта в таблице выше.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Номер</TableHead>
                  <TableHead className="h-8">Оператор</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                  <TableHead className="h-8 w-px">
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spare.map((sim) => (
                  <TableRow key={sim.id}>
                    <TableCell className="num">{sim.msisdn}</TableCell>
                    <TableCell>
                      {sim.operator_name ?? <span className="text-faint">—</span>}
                    </TableCell>
                    <TableCell>
                      <SimStateCell sim={sim} />
                    </TableCell>
                    <TableCell>
                      <RowActions>
                        <SimActions sim={sim} inPort={false} />
                        <span className="inline-flex md:ml-1.5">
                          <SimSwitch sim={sim} bare />
                        </span>
                      </RowActions>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * У каждого шлюза своя карточка с таблицей его портов (владелец, 2026-09-29: «может
 * разделить таблицы на каждый GOIP своя таблица?»). В общей таблице шапки шлюзов терялись
 * среди строк портов, а пустые слоты занимали бо́льшую часть экрана.
 *
 * Пустые порты сворачиваются в одну строку, когда на шлюзе уже есть карты: тогда важны
 * карты, а слоты — по запросу. У шлюза без единой карты порты видны все: его как раз
 * заполняют, и прятать то, куда вставлять, значило бы добавлять лишний шаг.
 */
function GatewaysTable({
  gateways,
  spare,
}: {
  gateways: readonly Gateway[];
  spare: readonly Sim[];
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const allCollapsed = gateways.every((gateway) => collapsed.has(gateway.id));

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {gateways.length > 1 && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCollapsed(allCollapsed ? new Set() : new Set(gateways.map((row) => row.id)));
            }}
          >
            {allCollapsed ? 'Раскрыть все' : 'Свернуть все'}
          </Button>
        </div>
      )}
      {gateways.map((gateway) => (
        <GatewayCard
          key={gateway.id}
          gateway={gateway}
          spare={spare}
          expanded={!collapsed.has(gateway.id)}
          onToggle={() => {
            toggle(gateway.id);
          }}
        />
      ))}
    </div>
  );
}

function GatewayCard({
  gateway,
  spare,
  expanded,
  onToggle,
}: {
  gateway: Gateway;
  spare: readonly Sim[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const filled = gateway.ports.filter((port) => port.sim !== null);
  const empty = gateway.ports.filter((port) => port.sim === null);
  const foldable = filled.length > 0 && empty.length > 0;
  const visible = foldable && !showEmpty ? filled : gateway.ports;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <section
      aria-label={gateway.name}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {/*
        Шапка шлюза — тоже одна линия (DESIGN.md, «Таблица»): название, модель, состояние точкой и словом, карты,
        настройки значком. Способ входа и «включён» — в подсказке состояния и в настройках шлюза.
      */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 py-1.5 pr-2 pl-1">
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Свернуть' : 'Раскрыть'} порты шлюза «${gateway.name}»`}
          onClick={onToggle}
        >
          <Chevron aria-hidden className="size-4" />
        </Button>
        <h3 className="min-w-0 truncate font-semibold" title={gateway.name}>
          <Link
            href={`/partner/equipment/${gateway.id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {gateway.name}
          </Link>
        </h3>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">
          {gateway.model ?? GATEWAY_TYPE_NAME[gateway.type]}
        </span>
        <span className="shrink-0">
          <GatewayState gateway={gateway} />
        </span>
        {gateway.poor_connection === true && (
          <span className="hidden shrink-0 sm:inline">
            <PoorConnection />
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">
          карт{' '}
          <span className="num text-foreground">
            {filled.length}/{gateway.ports.length}
          </span>
        </span>
        <RowActions>
          <Tooltip label="Настройки шлюза">
            <Button {...ROW_ICON} asChild>
              <Link href={`/partner/equipment/${gateway.id}`} aria-label="Настройки шлюза">
                <Settings aria-hidden className="size-4" />
              </Link>
            </Button>
          </Tooltip>
        </RowActions>
      </div>

      {expanded &&
        (gateway.ports.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground">
            Портов нет — добавьте их на странице шлюза.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <PortHeader gateway={gateway} />
              </TableHeader>
              <TableBody>
                {visible.map((port) => (
                  <PortRow key={port.id} gateway={gateway} port={port} spare={spare} />
                ))}
                {foldable && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={PORT_COLUMNS} className="text-muted-foreground">
                      {!showEmpty && (
                        <>
                          Пустые порты:{' '}
                          <span className="num">
                            {portRanges(empty.map((port) => port.port_number))}
                          </span>
                          {' · '}
                        </>
                      )}
                      <button
                        type="button"
                        className="text-primary underline-offset-4 hover:underline"
                        onClick={() => {
                          setShowEmpty((current) => !current);
                        }}
                      >
                        {showEmpty ? 'Скрыть пустые порты' : 'Показать — вставить SIM'}
                      </button>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        ))}
    </section>
  );
}

/**
 * Состояние шлюза одним словом: включённый — на связи ли он; иначе — почему не работает. Способ входа и адрес —
 * в подсказке и в настройках шлюза, а не в шапке.
 */
function GatewayState({ gateway }: { gateway: Gateway }) {
  if (gateway.status === 'active' && gateway.suspended_by === null) {
    return <Presence connection={gateway.connection} />;
  }
  const label = gatewayStateName(gateway).toLowerCase();
  const mode =
    gateway.type === 'goip' ? ` ${REGISTRATION_MODE_NAME[gateway.registration_mode]}.` : '';
  if (gateway.status === 'pending') {
    return (
      <StatusDot
        tone="warn"
        label={label}
        reason={`Шлюз ещё не включён: карты не получают вызовов. Включите его на странице шлюза.${mode}`}
      />
    );
  }
  if (gateway.suspended_by === 'platform') {
    return (
      <StatusDot
        tone="crit"
        label={label}
        reason="Шлюз отключила площадка — напишите в поддержку"
      />
    );
  }
  if (gateway.suspended_by === 'failure_threshold') {
    return (
      <StatusDot
        tone="warn"
        label={label}
        reason="Много неудачных вызовов подряд. Проверьте шлюз тестовым звонком и включите его на странице шлюза"
      />
    );
  }
  return <StatusDot tone="off" label={label} />;
}

/** Номера портов короткой записью: `2, 3, 5–8`. */
function portRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index] ?? 0;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      index += 1;
      end += 1;
    }
    if (end === start) parts.push(String(start));
    else if (end === start + 1) parts.push(`${String(start)}, ${String(end)}`);
    else parts.push(`${String(start)}–${String(end)}`);
    index += 1;
  }
  return parts.join(', ');
}
