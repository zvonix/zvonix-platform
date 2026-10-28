/**
 * Часовые пояса для выбора в «Аккаунте» ([ADR-0102](../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)).
 *
 * Россия — первой и по городам, которые люди узнают: «Новосибирск», а не `Asia/Novosibirsk`. Остальной мир —
 * списком среды браузера: имена IANA те же, что проверяет API.
 */

export interface TimezoneChoice {
  readonly id: string;
  readonly label: string;
}

export const RUSSIAN_TIMEZONES: readonly TimezoneChoice[] = [
  { id: 'Europe/Kaliningrad', label: 'Калининград (МСК−1)' },
  { id: 'Europe/Moscow', label: 'Москва (МСК)' },
  { id: 'Europe/Simferopol', label: 'Симферополь (МСК)' },
  { id: 'Europe/Volgograd', label: 'Волгоград (МСК)' },
  { id: 'Europe/Kirov', label: 'Киров (МСК)' },
  { id: 'Europe/Samara', label: 'Самара (МСК+1)' },
  { id: 'Europe/Saratov', label: 'Саратов (МСК+1)' },
  { id: 'Europe/Ulyanovsk', label: 'Ульяновск (МСК+1)' },
  { id: 'Europe/Astrakhan', label: 'Астрахань (МСК+1)' },
  { id: 'Asia/Yekaterinburg', label: 'Екатеринбург (МСК+2)' },
  { id: 'Asia/Omsk', label: 'Омск (МСК+3)' },
  { id: 'Asia/Novosibirsk', label: 'Новосибирск (МСК+4)' },
  { id: 'Asia/Barnaul', label: 'Барнаул (МСК+4)' },
  { id: 'Asia/Tomsk', label: 'Томск (МСК+4)' },
  { id: 'Asia/Novokuznetsk', label: 'Кемерово, Новокузнецк (МСК+4)' },
  { id: 'Asia/Krasnoyarsk', label: 'Красноярск (МСК+4)' },
  { id: 'Asia/Irkutsk', label: 'Иркутск (МСК+5)' },
  { id: 'Asia/Chita', label: 'Чита (МСК+6)' },
  { id: 'Asia/Yakutsk', label: 'Якутск (МСК+6)' },
  { id: 'Asia/Vladivostok', label: 'Владивосток (МСК+7)' },
  { id: 'Asia/Sakhalin', label: 'Сахалин (МСК+8)' },
  { id: 'Asia/Magadan', label: 'Магадан (МСК+8)' },
  { id: 'Asia/Srednekolymsk', label: 'Среднеколымск (МСК+8)' },
  { id: 'Asia/Kamchatka', label: 'Камчатка (МСК+9)' },
  { id: 'Asia/Anadyr', label: 'Анадырь (МСК+9)' },
];

const RUSSIAN = new Set(RUSSIAN_TIMEZONES.map((zone) => zone.id));

/** Пояса остального мира — из среды браузера, без российских: они уже в списке выше. */
export function otherTimezones(): readonly string[] {
  return Intl.supportedValuesOf('timeZone').filter((zone) => !RUSSIAN.has(zone));
}

/** Человеческое имя пояса: город России — как в списке, прочее — город из имени IANA. */
export function timezoneLabel(id: string): string {
  const russian = RUSSIAN_TIMEZONES.find((zone) => zone.id === id);
  if (russian !== undefined) return russian.label;
  if (id === 'UTC') return 'UTC';
  return (id.split('/').at(-1) ?? id).replaceAll('_', ' ');
}
