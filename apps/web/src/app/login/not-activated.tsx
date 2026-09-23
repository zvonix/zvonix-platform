'use client';

import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';

/**
 * Что делать, когда пароль верный, а вход закрыт.
 *
 * Один «не активирована» ничего не говорит: человек с истёкшей ссылкой ждёт
 * администратора, а администратор не одобрит заявку, пока адрес не подтверждён.
 * API отвечает на это полями `status` и `email_confirmed` — они доходят только до того,
 * кто ввёл верный пароль ([auth.md](../../../../../docs/api/auth.md)).
 *
 * Письмо запрашивается теми же адресом и паролем, что и вход: сессии у такого человека
 * нет и быть не может.
 */
export function NotActivated({
  error,
  email,
  password,
  captchaToken,
  captchaRequired,
  onCaptchaSpent,
}: {
  error: ApiError;
  email: string;
  password: string;
  captchaToken: string | undefined;
  captchaRequired: boolean;
  onCaptchaSpent: () => void;
}) {
  const resend = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/email/resend-by-password', {
        method: 'POST',
        body: { email, password, ...(captchaToken === undefined ? {} : { captchaToken }) },
      }),
    // Пройденный токен капчи одноразовый — и после успеха, и после отказа.
    onSettled: onCaptchaSpent,
  });

  if (error.details['status'] !== 'pending') {
    return (
      <p role="alert" className="text-crit">
        Вход закрыт администратором. Если это ошибка — напишите в поддержку.
      </p>
    );
  }

  if (error.details['email_confirmed'] === true) {
    return (
      <p role="alert" className="text-muted-foreground">
        Адрес подтверждён. Заявка ждёт проверки администратором — войти можно будет после её
        одобрения.
      </p>
    );
  }

  const resendError = resend.error instanceof ApiError ? resend.error : undefined;
  const waitSeconds = resendError?.details['retry_after_seconds'];

  return (
    <div role="alert" className="flex flex-col gap-2">
      <p>
        <span className="font-semibold">Адрес почты не подтверждён.</span> Откройте ссылку из
        письма, которое пришло после подачи заявки. Ссылка действует сутки; письма нет или она
        устарела — пришлём новую.
      </p>

      {resend.isSuccess ? (
        <p className="text-muted-foreground">
          Письмо ушло на <b>{email}</b>. Нет несколько минут — проверьте папку «Спам».
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={resend.isPending || (captchaRequired && captchaToken === undefined)}
          onClick={() => {
            resend.mutate();
          }}
        >
          {resend.isPending ? 'Отправляем…' : 'Прислать письмо ещё раз'}
        </Button>
      )}

      {captchaRequired && captchaToken === undefined && !resend.isSuccess && (
        <p className="text-muted-foreground">Сначала пройдите проверку «я не робот» выше.</p>
      )}

      {resendError !== undefined && (
        <p className="text-crit">
          {typeof waitSeconds === 'number'
            ? `Писем было слишком много. Повторите через ${String(Math.ceil(waitSeconds / 60))} мин.`
            : resendError.message}
        </p>
      )}
    </div>
  );
}
