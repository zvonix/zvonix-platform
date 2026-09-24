'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
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
import { GATEWAY_STATUS_NAME, GATEWAY_TYPE_NAME, SIM_STATUS_NAME } from '@/lib/labels';
import { EQUIPMENT_KEY, gatewayStateName, type Equipment } from './equipment';
import { AddGateway, SimActions } from './manage';

export default function PartnerEquipmentPage() {
  return (
    <ConsoleShell title="Моё оборудование" cabinet="partner">
      {() => <PartnerEquipment />}
    </ConsoleShell>
  );
}

/**
 * Оборудование списком: шлюз — строка таблицы, по нажатию — его страница с портами
 * и настройками подключения. Раньше каждый шлюз был строкой текста с рядом кнопок
 * над таблицей портов, и шлюз читался как «где-то сверху», а не как объект списка
 * (владелец, 2026-09-24).
 */
function PartnerEquipment() {
  const equipment = useQuery({
    queryKey: EQUIPMENT_KEY,
    queryFn: () => request<Equipment>('/partner/equipment'),
  });

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
  const offline = gateways.filter((gateway) => gateway.status === 'active' && !gateway.on_node);

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
      {offline.length > 0 && (
        <p className="text-warn">
          {offline.length === 1
            ? 'Шлюз не на связи'
            : `Шлюзов не на связи: ${String(offline.length)}`}{' '}
          — вызовы на {offline.length === 1 ? 'него' : 'них'} не идут. Проверьте питание, сеть и
          настройки подключения на странице шлюза.
        </p>
      )}

      <AddGateway />

      {gateways.length === 0 && trunks.length === 0 ? (
        <div className="flex max-w-prose flex-col gap-1 text-muted-foreground">
          <p>Оборудования пока нет. Порядок такой:</p>
          <ol className="list-decimal pl-5">
            <li>Добавьте шлюз — порты под SIM появятся сразу.</li>
            <li>Введите в настройках устройства сервер, логин и пароль со страницы шлюза.</li>
            <li>Вставьте SIM-карты в порты и включите шлюз.</li>
          </ol>
        </div>
      ) : (
        gateways.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Шлюз</TableHead>
                  <TableHead className="h-8">Вид</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                  <TableHead className="h-8">Связь с площадкой</TableHead>
                  <TableHead className="h-8 text-right">Карт в портах</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gateways.map((gateway) => {
                  const filled = gateway.ports.filter((port) => port.sim !== null).length;
                  return (
                    <TableRow key={gateway.id}>
                      <TableCell>
                        <Link
                          href={`/partner/equipment/${gateway.id}`}
                          className="font-semibold text-primary underline-offset-4 hover:underline"
                        >
                          {gateway.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {GATEWAY_TYPE_NAME[gateway.type]}
                        {gateway.model !== null && ` · ${gateway.model}`}
                      </TableCell>
                      <TableCell>{gatewayStateName(gateway)}</TableCell>
                      <TableCell className={gateway.on_node ? '' : 'text-warn'}>
                        {gateway.on_node
                          ? `на связи · ${moment(gateway.registered_at)}`
                          : 'не на связи'}
                      </TableCell>
                      <TableCell className="num text-right">
                        {`${String(filled)} из ${String(gateway.ports.length)}`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )
      )}

      {trunks.length > 0 && (
        <section aria-labelledby="trunks" className="flex flex-col gap-2">
          <h3 id="trunks" className="font-semibold">
            SIP-транки
          </h3>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
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
            Транк добавляет и настраивает площадка. Пароль провайдера она не показывает никому: он
            уходит только на узел. Сменился пароль у провайдера — сообщите площадке.
          </p>
        </section>
      )}

      {spare.length > 0 && (
        <section aria-labelledby="spare" className="flex flex-col gap-2">
          <h3 id="spare" className="font-semibold">
            Карты вне шлюзов
          </h3>
          <p className="max-w-prose text-muted-foreground">
            Вынутые из портов карты вызовов не получают. Вставить такую карту можно из порта на
            странице шлюза.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
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
                    <TableCell>{SIM_STATUS_NAME[sim.status]}</TableCell>
                    <TableCell>
                      <SimActions sim={sim} inPort={false} />
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
