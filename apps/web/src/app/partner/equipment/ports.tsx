'use client';

import { goipLinePrefix, TESTABLE_SIM_STATUSES } from '@zvonix/shared';
import { RowActions, WIDE_ONLY } from '@/components/table-parts';
import { StatusDot } from '@/components/status-dot';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { TestCallButton } from '@/components/test-call';
import { TariffSelect } from '@/components/tariff-select';
import { PARTNER_RATES_KEY } from '@/lib/tariffs';
import { Presence } from '@/components/presence';
import { EQUIPMENT_KEY, type Gateway, type Port, type Sim } from './equipment';
import { InsertSim, RemoveSim, SimActions, SimSwitch, simState } from './manage';

/**
 * Строки портов — одни на общую таблицу оборудования и на страницу шлюза
 * ([ADR-0054](../../../../../../docs/adr/0054-vhod-po-liniyam-goip.md), «Кабинет»):
 * две копии разошлись бы на первой же правке, и партнёр видел бы один порт по-разному.
 *
 * По стандарту таблицы ([DESIGN.md](../../../../../../docs/DESIGN.md), «Таблица»): строка в одну линию, состояние —
 * переключатель и одно слово с причиной в подсказке, действия — значками справа.
 */

/** Столбцов у строки порта — для строк во всю ширину таблицы. */
export const PORT_COLUMNS = 7;

export function PortHeader() {
  return (
    <TableRow className="text-muted-foreground hover:bg-transparent">
      <TableHead className="h-8 w-12">Порт</TableHead>
      <TableHead className={`h-8 ${WIDE_ONLY}`}>Линия</TableHead>
      <TableHead className="h-8">SIM-карта</TableHead>
      <TableHead className={`h-8 ${WIDE_ONLY}`}>Оператор</TableHead>
      <TableHead className="h-8">Состояние</TableHead>
      <TableHead className={`h-8 w-44 ${WIDE_ONLY}`}>Тариф</TableHead>
      <TableHead className="h-8 w-px">
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
    <TableRow>
      <TableCell className="num">{port.port_number}</TableCell>
      <TableCell className={WIDE_ONLY}>
        <LineCell gateway={gateway} port={port} />
      </TableCell>
      <TableCell className="num">
        {port.sim?.msisdn ?? <span className="text-faint">пусто</span>}
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        {port.sim?.operator_name ?? <span className="text-faint">—</span>}
      </TableCell>
      <TableCell>
        {port.sim === null ? (
          <span className="text-faint">—</span>
        ) : (
          <SimStateCell sim={port.sim} port={port} />
        )}
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        {port.sim === null ? (
          <span className="text-faint">—</span>
        ) : (
          <SimTariff gateway={gateway} sim={port.sim} />
        )}
      </TableCell>
      <TableCell>
        <RowActions>
          {port.sim === null ? (
            <InsertSim portId={port.id} portNumber={port.port_number} spare={spare} />
          ) : (
            <>
              <SimActions sim={port.sim} inPort />
              {TESTABLE_SIM_STATUSES.includes(port.sim.status) && (
                <TestCallButton
                  scope="partner"
                  subject={{ kind: 'sim', id: port.sim.id, msisdn: port.sim.msisdn }}
                />
              )}
              <RemoveSim portId={port.id} />
            </>
          )}
        </RowActions>
      </TableCell>
    </TableRow>
  );
}

/**
 * Переключатель и одно слово: «работает», «прогрев 4/14», «предел суток», «выключена». Прогрев, пределы, сон
 * и состояние слота — в подсказке слова: раньше они шли хвостом «· прогрев 4/14 · 0 из 23 за сутки · спит до 16:37»
 * и растягивали строку (владелец, 2026-11-17).
 */
export function SimStateCell({ sim, port }: { sim: Sim; port?: Port }) {
  const state = simState(sim, port?.state);
  return (
    <div className="flex items-center gap-2">
      <SimSwitch sim={sim} bare />
      <StatusDot tone={state.tone} label={state.label} reason={state.reason} />
    </div>
  );
}

/**
 * Тариф карты: свой или «как у шлюза» (ADR-0056; владелец: «тариф выбирается для всего
 * GOIP и меняется у каждой SIM»). Куда карта звонит, решает её тариф.
 */
function SimTariff({ gateway, sim }: { gateway: Gateway; sim: Sim }) {
  return (
    <TariffSelect
      value={sim.tariff_id}
      inheritedId={gateway.tariff_id}
      inheritedFrom="тариф шлюза"
      kind="sim"
      endpoint={`/partner/sim-cards/${sim.id}/tariff`}
      label={`Тариф карты ${sim.msisdn}`}
      invalidate={[EQUIPMENT_KEY, PARTNER_RATES_KEY]}
    />
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
    <span className="inline-flex items-center gap-2">
      <span className="num">Line {port.port_number}</span>
      {port.sip_username === null ? (
        <StatusDot
          tone="warn"
          label="нет входа"
          reason="Линии ещё не выдан логин и пароль — выдайте их в настройках шлюза"
        />
      ) : (
        // В строке важно «да или нет», адрес и время — подсказкой.
        <Presence connection={port.connection} />
      )}
    </span>
  );
}

/**
 * Почти не соединяет из-за отказов сети за последний час (ADR-0103, п. 5) — то же, о чём партнёру пришло письмо.
 * Для шапки шлюза — точкой и словом, как всё состояние.
 */
export function PoorConnection() {
  return (
    <StatusDot
      tone="warn"
      label="не соединяет"
      reason="За последний час большинство вызовов сорвались в сети: проверьте баланс и блокировку SIM, сигнал, сам шлюз"
    />
  );
}
