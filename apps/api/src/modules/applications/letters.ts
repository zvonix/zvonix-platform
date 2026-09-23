/**
 * Письма о решении по заявке на кабинет
 * ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Чистые функции, как и письма учётных записей: текст проверяется сравнением строк.
 */

import type { Cabinet } from '@zvonix/shared';
import type { Letter } from '../identity/letters.js';

const CABINET_NAME: Record<Cabinet, string> = {
  client: 'кабинет службы такси',
  partner: 'кабинет партнёра',
};

function loginUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/login`;
}

/** Партнёру важно и то, что будет дальше: звонки пойдут не сразу. */
const NEXT_STEP: Record<Cabinet, readonly string[]> = {
  client: ['Линии для звонков настраиваются в кабинете, баланс — в разделе «Деньги».'],
  partner: [
    'Заведите в кабинете шлюзы и SIM и назначьте цены. Звонки на ваши SIM',
    'пойдут после того, как администратор проверит оборудование.',
  ],
};

export function applicationApprovedLetter(baseUrl: string, cabinet: Cabinet): Letter {
  return {
    kind: 'application_approved',
    subject: 'Заявка в Zvonix одобрена',
    body: [
      `Ваша заявка одобрена: ${CABINET_NAME[cabinet]} открыт.`,
      '',
      'Войдите тем же адресом и паролем:',
      loginUrl(baseUrl),
      '',
      ...NEXT_STEP[cabinet],
    ].join('\n'),
  };
}

export function applicationRejectedLetter(cabinet: Cabinet, note: string): Letter {
  return {
    kind: 'application_rejected',
    subject: 'Заявка в Zvonix не одобрена',
    body: [
      `Заявку на ${CABINET_NAME[cabinet]} администратор не одобрил. Причина:`,
      '',
      note,
      '',
      'Если причину можно устранить, подайте заявку заново.',
    ].join('\n'),
  };
}
