'use client';

import { goipLinePrefix, TESTABLE_SIM_STATUSES } from '@zvonix/shared';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { moment } from '@/lib/format';
import { PORT_STATE_NAME, SIM_STATUS_NAME } from '@/lib/labels';
import type { Gateway, Port, Sim } from './equipment';
import { TestCallButton } from '@/components/test-call';
import { InsertSim, RemoveSim, SimActions } from './manage';

/**
 * Строки портов — одни на общую таблицу оборудования и на страницу шлюза
 * ([ADR-0054](../../../../../../docs/adr/0054-vhod-po-liniyam-goip.md), «Кабинет»):
 * две копии разошлись бы на первой же правке, и партнёр видел бы один порт по-разному.
 */

/** Столбцов у строки порта — для строк во всю ширину таблицы. */
export const PORT_COLUMNS = 6;

export function PortHeader() {
  return (
    <TableRow className="text-muted-foreground hover:bg-transparent">
      <TableHead className="h-8 w-[64px]">Порт</TableHead>
      <TableHead className="h-8">Линия</TableHead>
      <TableHead className="h-8">SIM-карта</TableHead>
      <TableHead className="h-8">Оператор</TableHead>
      <TableHead className="h-8">Состояние</TableHead>
      <TableHead className="h-8">
        <span className="sr-only">Действия</span>
      </TableHead>
    </TableRow>
  );
}

export function PortRow({
  gateway,
  port,
  spare,
}: {
  gateway: Gateway;
  port: Port;
  spare: readonly Sim[];
}) {
  return (
    // В одну строчку: у партнёра десятки портов, и строка в две высоты вдвое сокращала то,
    // что видно на экране без прокрутки (владелец, 2026-09-25).
    <TableRow className="whitespace-nowrap">
      <TableCell className="num">{port.port_number}</TableCell>
      <TableCell>
        <LineCell gateway={gateway} port={port} />
      </TableCell>
      <TableCell className="num">
        {port.sim?.msisdn ?? <span className="text-faint">пусто</span>}
      </TableCell>
      <TableCell>{port.sim?.operator_name ?? <span className="text-faint">—</span>}</TableCell>
      <TableCell>
        {port.sim === null ? (
          <span className="text-faint">—</span>
        ) : (
          <>
            {/*
              Подтверждение оператора площадкой партнёру ничего не даёт и ничего от него
              не требует (владелец, 2026-09-25) — здесь только состояние карты.
            */}
            {SIM_STATUS_NAME[port.sim.status]}
          </>
        )}
        {/*
          Состояние слота сообщает оборудование; «не опрошен» и «свободен» партнёру ничего
          не говорят, а неисправный или выключенный слот — причина, почему карта молчит.
        */}
        {(port.state === 'fault' || port.state === 'disabled') && (
          <span className="text-warn"> · слот {PORT_STATE_NAME[port.state]}</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-start justify-end gap-2">
          {port.sim === null ? (
            <InsertSim portId={port.id} portNumber={port.port_number} spare={spare} />
          ) : (
            <>
              <SimActions sim={port.sim} inPort />
              {TESTABLE_SIM_STATUSES.includes(port.sim.status) && (
                <TestCallButton scope="partner" simId={port.sim.id} msisdn={port.sim.msisdn} />
              )}
              <RemoveSim portId={port.id} />
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Как площадка выбирает эту линию. При входе на шлюз — префиксом, который вводится
 * в GOIP как `Routing Prefix` линии; при входе по линиям — её собственным входом,
 * и здесь важно одно: на связи ли она. Логин и пароль линии — в настройках линий
 * на странице шлюза, где устройство и настраивают.
 */
function LineCell({ gateway, port }: { gateway: Gateway; port: Port }) {
  // У телефона слот один — выбирать нечего.
  if (gateway.type !== 'goip') return <span className="text-faint">—</span>;

  if (gateway.registration_mode === 'gateway') {
    return (
      <>
        <span className="text-faint">префикс </span>
        <span className="num select-all">{goipLinePrefix(port.port_number)}</span>
      </>
    );
  }

  return (
    <>
      <span className="num">Line {port.port_number}</span>
      <span className="text-faint"> · </span>
      {port.sip_username === null ? (
        <span className="text-warn">вход не выдан</span>
      ) : (
        // Когда отмечена связь — подсказкой: в строке важно «да или нет», время — по запросу.
        <Presence
          online={port.on_node}
          title={port.on_node ? `отметка ${moment(port.registered_at)}` : undefined}
        />
      )}
    </>
  );
}

/**
 * На связи ли устройство: точка и слово одного цвета — зелёный «да», жёлтый «нет»
 * (владелец, 2026-09-29: «на связи может писать другим цветом»). Слово остаётся:
 * один цвет не читается при нарушенном цветовосприятии.
 */
export function Presence({ online, title }: { online: boolean; title?: string | undefined }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${online ? 'text-ok' : 'text-warn'}`}
      title={title}
    >
      <span aria-hidden className={`size-2 rounded-full ${online ? 'bg-ok' : 'bg-warn'}`} />
      {online ? 'на связи' : 'не на связи'}
    </span>
  );
}
