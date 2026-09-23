'use client';

import { useQuery } from '@tanstack/react-query';
import { ConsoleShell } from '@/components/console-shell';
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
import {
  GATEWAY_STATUS_NAME,
  GATEWAY_TYPE_NAME,
  PARTNER_SUSPENSION_NAME,
  PORT_STATE_NAME,
  SIM_STATUS_NAME,
} from '@/lib/labels';
import type { Equipment, Gateway, Sim } from './equipment';
import { AddGateway, AddSim, GatewayActions, PortSim, SimActions } from './manage';

export default function PartnerEquipmentPage() {
  return (
    <ConsoleShell title="Моё оборудование" cabinet="partner">
      {() => <PartnerEquipment />}
    </ConsoleShell>
  );
}

function PartnerEquipment() {
  const equipment = useQuery({
    queryKey: ['partner', 'equipment'],
    queryFn: () => request<Equipment>('/partner/equipment'),
  });

  if (equipment.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  // Ранний выход — только когда показывать нечего. Неудачное фоновое обновление (партнёр
  // вернулся из вкладки с настройками GOIP) не должно размонтировать формы: вместе с ними
  // пропадал только что выданный пароль SIP, который показывается один раз.
  if (equipment.data === undefined) {
    return (
      <p role="alert" className="text-crit">
        {equipment.error.message}
      </p>
    );
  }

  const { gateways, trunks, spare_sims: spare } = equipment.data;
  const offline = gateways.filter((gateway) => gateway.status === 'active' && !gateway.on_node);

  return (
    <div className="flex flex-col gap-4">
      {/* Обновление не удалось, но загруженное остаётся на экране — вместе с формами
          и выданным паролем. */}
      {equipment.error !== null && (
        <p role="alert" className="text-crit">
          Не удалось обновить оборудование: {equipment.error.message}. Показано последнее
          загруженное.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {/*
          Самое дорогое из невидимого: включённый шлюз без регистрации выглядит рабочим
          в любом списке, но вызов на него не уйдёт вовсе — набрать его с узла нечем.
        */}
        {offline.length > 0 && (
          <p className="text-warn">
            {offline.length === 1
              ? 'Шлюз не на связи'
              : `Шлюзов не на связи: ${String(offline.length)}`}{' '}
            — вызовы на {offline.length === 1 ? 'него' : 'них'} не идут вовсе. Проверьте питание,
            сеть и настройки регистрации SIP на самом оборудовании.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <AddGateway />
        <AddSim />
      </div>

      {gateways.length === 0 && trunks.length === 0 && (
        <p className="max-w-prose text-muted-foreground">
          Оборудования пока нет. Заведите шлюз — пароль SIP выдаётся сразу, им вы и настроите
          устройство. SIP-транк заводит площадка: он привязывается к её узлу.
        </p>
      )}

      {gateways.map((gateway) => (
        <GatewayCard key={gateway.id} gateway={gateway} spare={spare} />
      ))}

      {trunks.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">SIP-транки</h3>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Название</TableHead>
                  <TableHead className="h-8">Провайдер</TableHead>
                  <TableHead className="h-8">Доступ</TableHead>
                  <TableHead className="h-8 text-right">Каналов</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trunks.map((trunk) => (
                  <TableRow key={trunk.id}>
                    <TableCell>{trunk.name}</TableCell>
                    <TableCell className="num">{trunk.proxy_host}</TableCell>
                    <TableCell>
                      {trunk.registers_outbound ? (
                        <>
                          регистрация
                          <span className="block text-faint num">
                            {trunk.outbound_username ?? '—'}
                          </span>
                        </>
                      ) : (
                        'по адресу'
                      )}
                    </TableCell>
                    <TableCell className="num text-right">{trunk.max_concurrent_calls}</TableCell>
                    <TableCell>
                      {GATEWAY_STATUS_NAME[trunk.status]}
                      {!trunk.on_node && <span className="block text-warn">узел не назначен</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="max-w-prose text-muted-foreground">
            Пароль провайдера площадка не показывает никому: он уходит только на узел, в его
            конфигурацию. Если пароль сменился у провайдера — сообщите площадке, его заведут заново.
          </p>
        </div>
      )}

      {spare.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Карты вне шлюзов</h3>
          <p className="max-w-prose text-muted-foreground">
            Эти карты заведены, но не стоят ни в одном порту — значит, вызовов не получают.
          </p>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Номер</TableHead>
                  <TableHead className="h-8">Оператор</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                  <TableHead className="h-8" />
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
                      {SIM_STATUS_NAME[sim.status]}
                      {sim.operator_confirmed_at === null && (
                        <span className="block text-warn">оператор не подтверждён</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <SimActions sim={sim} inPort={false} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Шлюз с портами: одна карточка — одна железка, как она стоит у партнёра. */
function GatewayCard({ gateway, spare }: { gateway: Gateway; spare: readonly Sim[] }) {
  return (
    // Область с именем: у партнёра шлюзов бывает десяток, и без имени и человек
    // с экранным диктором, и проверка одинаково не понимают, к какому из них
    // относится кнопка.
    <section aria-label={gateway.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-semibold">{gateway.name}</h3>
        <span className="text-muted-foreground">{GATEWAY_TYPE_NAME[gateway.type]}</span>
        {gateway.model !== null && <span className="text-faint">{gateway.model}</span>}
        <span className="text-muted-foreground">
          {/* У выключенного важнее не «приостановлен», а кто выключил: от этого зависит,
              может ли партнёр включить его сам (ADR-0047). */}
          {gateway.suspended_by === null
            ? GATEWAY_STATUS_NAME[gateway.status]
            : PARTNER_SUSPENSION_NAME[gateway.suspended_by]}
        </span>
        <span className={gateway.on_node ? 'text-muted-foreground' : 'text-warn'}>
          {gateway.on_node ? `на связи · ${moment(gateway.registered_at)}` : 'не на связи с узлом'}
        </span>
      </div>

      <GatewayActions gateway={gateway} />

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8 w-[70px]">Порт</TableHead>
              <TableHead className="h-8">Номер SIM</TableHead>
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Карта</TableHead>
              <TableHead className="h-8 text-right">Одновременных</TableHead>
              <TableHead className="h-8">Порт</TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {gateway.ports.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="whitespace-normal text-muted-foreground">
                  Портов не заведено. Пока их нет, шлюз не может принять ни одного вызова.
                </TableCell>
              </TableRow>
            )}

            {gateway.ports.map((port) => (
              <TableRow key={port.id}>
                <TableCell className="num">{port.port_number}</TableCell>
                <TableCell className="num">
                  {port.sim?.msisdn ?? <span className="text-faint">пусто</span>}
                </TableCell>
                <TableCell>
                  {port.sim?.operator_name ?? <span className="text-faint">—</span>}
                </TableCell>
                <TableCell>
                  {port.sim === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <>
                      {SIM_STATUS_NAME[port.sim.status]}
                      {port.sim.operator_confirmed_at === null && (
                        <span className="block text-warn">оператор не подтверждён</span>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {port.sim?.max_concurrent_calls ?? <span className="text-faint">—</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {PORT_STATE_NAME[port.state]}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-start gap-2">
                    <PortSim portId={port.id} spare={spare} filled={port.sim !== null} />
                    {port.sim !== null && <SimActions sim={port.sim} inPort />}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
