/**
 * Тексты писем ([ADR-0029](../../../../../docs/adr/0029-pochta.md)).
 *
 * Чистые функции: письмо — это текст, и проверять его удобнее сравнением строк,
 * чем поднятием почтового сервера. Разметки нет намеренно — транзакционному письму
 * она не нужна, а вёрстка под полтора десятка почтовых клиентов нужна ещё меньше.
 */

export interface Letter {
  readonly subject: string;
  readonly body: string;
  /** Зачем письмо: по нему видно, чего именно не доходит, когда почта сломалась. */
  readonly kind: string;
}

/** Ссылка в кабинет с одноразовым токеном. */
function link(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('token', token);
  return url.toString();
}

export function passwordResetLetter(baseUrl: string, token: string, hours: number): Letter {
  return {
    kind: 'password_reset',
    subject: 'Восстановление пароля в Zvonix',
    body: [
      'Кто-то запросил восстановление пароля для этого адреса.',
      '',
      `Ссылка действует ${String(hours)} ч и сработает один раз:`,
      link(baseUrl, 'reset-password', token),
      '',
      'Если это были не вы, ничего делать не нужно: пароль останется прежним.',
    ].join('\n'),
  };
}

export function emailVerificationLetter(baseUrl: string, token: string, hours: number): Letter {
  return {
    kind: 'email_verification',
    subject: 'Подтверждение адреса в Zvonix',
    body: [
      'Вы зарегистрировались в Zvonix. Подтвердите, что это ваш адрес:',
      link(baseUrl, 'confirm-email', token),
      '',
      `Ссылка действует ${String(hours)} ч.`,
      '',
      'Доступ откроется после проверки администратором — подтверждение адреса',
      'её не заменяет.',
    ].join('\n'),
  };
}

/**
 * Письмо тому, чей адрес уже занят.
 *
 * Отправляется вместо отказа «адрес занят»: ответ регистрации не должен зависеть
 * от существования записи, иначе по нему перебирают адреса. Заодно человек узнаёт,
 * что его адресом попытались воспользоваться.
 */
export function registrationAttemptLetter(baseUrl: string): Letter {
  return {
    kind: 'registration_attempt',
    subject: 'Попытка регистрации в Zvonix',
    body: [
      'На ваш адрес попытались зарегистрироваться в Zvonix, но он уже занят —',
      'скорее всего, вами.',
      '',
      'Если пароль забыт, восстановите его:',
      `${baseUrl.replace(/\/$/, '')}/forgot-password`,
      '',
      'Если это были не вы, ничего делать не нужно.',
    ].join('\n'),
  };
}
