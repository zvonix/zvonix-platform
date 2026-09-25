'use client';

import type { ReactNode } from 'react';
import { OneTimeSecret } from '@/components/one-time-secret';

export interface SipAccount {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

/**
 * Выданный доступ с подписью — чей он.
 *
 * Хранится там, что не сворачивается: в строке таблицы панель пропадала вместе
 * со строкой, а второго показа пароля не будет.
 */
export interface IssuedCredentials {
  readonly title: string;
  readonly account: SipAccount;
}

/**
 * Учётные данные SIP, выданные один раз.
 *
 * В базе лежит `MD5(имя:realm:пароль)`, а не пароль: восстановить его неоткуда,
 * и второго показа не будет. Потерян — перевыпускается, и старый перестаёт работать.
 *
 * До появления этого экрана шлюзы и каналы заводились командой в терминале — то есть
 * пароль SIP оседал в истории оболочки на машине администратора.
 */
export function SipCredentials({
  account,
  title,
  onClose,
  children,
}: {
  account: SipAccount;
  title: string;
  onClose: () => void;
  /** Что делать дальше — например, ссылка на страницу шлюза. */
  children?: ReactNode;
}) {
  return (
    <OneTimeSecret title={title} onClose={onClose}>
      <p>
        Пароль показывается <b>один раз</b> — в базе его нет, только хеш. Перепишите его сейчас:
        восстановить будет нечем, останется только перевыпустить доступ, и тогда настраивать
        соединение придётся заново.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Имя</dt>
        <dd className="num select-all">{account.username}</dd>
        <dt className="text-muted-foreground">Пароль</dt>
        <dd className="num select-all">{account.password}</dd>
        <dt className="text-muted-foreground">Сервер</dt>
        <dd className="num select-all">{account.realm}</dd>
      </dl>
      {children}
    </OneTimeSecret>
  );
}

/** Вход линии GOIP (ADR-0054) — учётная запись с портом, к которому она выдана. */
export interface PortAccount extends SipAccount {
  readonly port_id: string;
  readonly port_number: number;
}

/** Выданные разом входы линий одного шлюза — с подписью, чьи они. */
export interface IssuedLines {
  readonly title: string;
  readonly lines: readonly PortAccount[];
}

/** Любой одноразовый показ доступа: одна учётная запись или входы линий шлюза. */
export type IssuedSecret = IssuedCredentials | IssuedLines;

/**
 * Входы линий, выданные один раз
 * ([ADR-0054](../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
 *
 * Одной таблицей, а не панелью на линию: у GoIP8 их восемь, и восемь панелей
 * «перепишите сейчас» подряд читались бы как одна и та же ошибка. Подписи столбцов —
 * как поля в веб-интерфейсе GOIP (Configurations → Basic VoIP, Line N).
 */
export function LineCredentials({
  lines,
  title,
  onClose,
}: {
  lines: readonly PortAccount[];
  title: string;
  onClose: () => void;
}) {
  const realm = lines[0]?.realm ?? '';
  return (
    <OneTimeSecret title={title} onClose={onClose}>
      <p>
        Пароли показываются <b>один раз</b> — в базе их нет, только хеш. Перепишите их сейчас или
        сразу введите в GOIP: потеряете — выдайте линии новый вход на странице шлюза.
      </p>
      <p>
        <span className="text-muted-foreground">
          SIP Proxy, SIP Registrar Server у всех линий:{' '}
        </span>
        <span className="num select-all">{realm}</span>
      </p>
      <div className="overflow-x-auto">
        {/* Без переносов: разорванный логин или пароль переписывают с ошибкой. */}
        <table className="w-full text-left whitespace-nowrap">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pr-4 font-normal">Линия</th>
              <th className="pr-4 font-normal">Authentication ID, Phone Number</th>
              <th className="font-normal">Password</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.port_id}>
                <td className="num pr-4">Line {line.port_number}</td>
                <td className="num select-all pr-4">{line.username}</td>
                <td className="num select-all">{line.password}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </OneTimeSecret>
  );
}

/** Панель для любого одноразового показа: учётной записи или входов линий. */
export function IssuedSecretPanel({
  secret,
  onClose,
}: {
  secret: IssuedSecret;
  onClose: () => void;
}) {
  return 'lines' in secret ? (
    <LineCredentials lines={secret.lines} title={secret.title} onClose={onClose} />
  ) : (
    <SipCredentials account={secret.account} title={secret.title} onClose={onClose} />
  );
}
