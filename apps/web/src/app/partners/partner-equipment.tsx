'use client';

import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { PartnerCoverage } from './partner-coverage';
import { PartnerGateways } from './partner-gateways';
import { PartnerSims, type Sim } from './partner-sims';
import { PartnerTrunks } from './partner-trunks';

/**
 * Оборудование партнёра: шлюзы с портами, SIM, SIP-транки и покрытие.
 *
 * Отвечает на вопрос «есть ли партнёру чем звонить» и, что важнее, позволяет это
 * завести. До появления раздела шлюз заводился командой в терминале — то есть пароль
 * SIP оседал в истории оболочки, а показывается он ровно один раз.
 *
 * Список SIM спрашивается здесь, а не в двух местах: он нужен и самому разделу SIM,
 * и выпадающему списку установки SIM в порт. Два запроса за одним и тем же списком
 * разъехались бы ровно в тот момент, когда SIM только что объявили.
 */
export function PartnerEquipment({ partnerId }: { partnerId: string }) {
  const sims = useQuery({
    queryKey: ['sim-cards', partnerId],
    queryFn: () => request<{ sim_cards: Sim[] }>(`/sim-cards?partnerId=${partnerId}`),
  });

  const rows = sims.data?.sim_cards ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PartnerGateways
        partnerId={partnerId}
        sims={rows.map((sim) => ({ id: sim.id, msisdn: sim.msisdn, status: sim.status }))}
      />
      <PartnerSims partnerId={partnerId} sims={rows} pending={sims.isPending} error={sims.error} />
      <PartnerTrunks partnerId={partnerId} />
      <PartnerCoverage partnerId={partnerId} />
    </div>
  );
}
