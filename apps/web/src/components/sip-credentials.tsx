'use client';

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
}: {
  account: SipAccount;
  title: string;
  onClose: () => void;
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
    </OneTimeSecret>
  );
}
