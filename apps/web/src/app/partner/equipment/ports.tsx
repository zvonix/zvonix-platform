'use client';

import { goipLinePrefix, TESTABLE_SIM_STATUSES } from '@zvonix/shared';
import { warmupCell } from '@/components/number-pace';
import { RowActions, WIDE_ONLY } from '@/components/table-parts';
import { HintText, StatusDot } from '@/components/status-dot';
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
 * По стандарту таблицы ([DESIGN.md](../../../../../../docs/DESIGN.md), «Таблица»): строка в одну линию, слово,
 * одинаковое во всех строках, уходит в заголовок столбца («Префикс», «Прогрев»), состояние — только когда есть что
 * сказать, рубильник и значки действий — в конце строки (владелец, 2026-11-17).
 */

/** Столбцов у строки порта — для строк во всю ширину таблицы. */
export const PORT_COLUMNS = 8;

/** Что в столбце линии: префикс при входе на шлюз, «Line N» и связь — при входе по линиям. */
function lineHeader(gateway: Gateway): string {
  return gateway.type === 'goip' && gateway.registration_mode === 'gateway' ? 'Префикс' : 'Линия';
}

export function PortHeader({ gateway }: { gateway: Gateway }) {
  return (
    <TableRow className="text-muted-foreground hover:bg-transparent">
      <TableHead className="h-8 w-px">Порт</TableHead>
      <TableHead className={`h-8 ${WIDE_ONLY}`}>{lineHeader(gateway)}</TableHead>
      <TableHead className="h-8">SIM-карта</TableHead>
      <TableHead className={`h-8 ${WIDE_ONLY}`}>Оператор</TableHead>
      <TableHead className={`h-8 ${WIDE_ONLY}`}>Прогрев</TableHead>
      <TableHead className="h-8">
        {/* На телефоне в столбце одна точка — слово заголовка шире её и выдавливало рубильник за край. */}
        <span className="hidden md:inline">Состояние</span>
        <span className="sr-only md:hidden">Состояние</span>
      </TableHead>
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
      <TableCell className={WIDE_ONLY}>
        <WarmupCell sim={port.sim} />
      </TableCell>
      <TableCell>{port.sim !== null && <SimStateCell sim={port.sim} port={port} />}</TableCell>
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
              <span className="inline-flex md:ml-1.5">
                <SimSwitch sim={port.sim} bare />
              </span>
            </>
          )}
        </RowActions>
      </TableCell>
    </TableRow>
  );
}

/** «4/14» с подсказкой; прогретый номер — пусто. */
export function WarmupCell({ sim }: { sim: Sim | null }) {
  const warmup = sim === null || sim.status !== 'active' ? null : warmupCell(sim.pace);
  return warmup === null ? null : <HintText label={warmup.label} reason={warmup.reason} />;
}

/**
 * Только то, что мешает карте звонить: «предел суток», «спит до 17:26», «придержана». Включена ли карта, показывает
 * рубильник в конце строки, прогрев — свой столбец; всё в порядке — ячейка пуста (владелец, 2026-11-17).
 */
export function SimStateCell({ sim, port }: { sim: Sim; port?: Port }) {
  // Вне порта карта вызовов не получает: прогрев, пределы и сон к ней не относятся.
  const state = port === undefined && sim.status === 'active' ? null : simState(sim, port?.state);
  return state === null ? null : (
    <StatusDot tone={state.tone} label={state.label} reason={state.reason} phoneDot />
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
 * в GOIP как `Routing Prefix` линии (слово «префикс» — в заголовке столбца); при входе по линиям — её
 * собственным входом, и здесь важно одно: на связи ли она — точкой, пояснение в подсказке. Логин и пароль
 * линии — в настройках линий на странице шлюза, где устройство и настраивают.
 */
function LineCell({ gateway, port }: { gateway: Gateway; port: Port }) {
  // У телефона слот один — выбирать нечего.
  if (gateway.type !== 'goip') return <span className="text-faint">—</span>;

  if (gateway.registration_mode === 'gateway') {
    return <span className="num select-all">{goipLinePrefix(port.port_number)}</span>;
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className="num">Line {port.port_number}</span>
      {port.sip_username === null ? (
        <StatusDot
          tone="warn"
          label="нет входа"
          reason="Линии ещё не выдан логин и пароль — выдайте их в настройках шлюза"
          dotOnly
        />
      ) : (
        <Presence connection={port.connection} dotOnly />
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
