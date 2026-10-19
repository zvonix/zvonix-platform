import { z } from 'zod';

/** Метка выпуска — тот же шаблон, что в `deploy/deploy.sh` и `deploy/updater.py`. */
const releaseTagSchema = z
  .string()
  .max(100, 'слишком длинная метка')
  .regex(/^v?[0-9A-Za-z][0-9A-Za-z._-]*$/u, 'метка выпуска записана неверно');

export const deployRequestSchema = z.object({ tag: releaseTagSchema });

export const logQuerySchema = z.object({
  offset: z.coerce.number().int('должно быть целым числом').min(0).default(0),
});

export const certificateAutoSchema = z.object({ enabled: z.boolean() });

/** Токен GitHub: классический (`ghp_…`) или fine-grained (`github_pat_…`) — буквы, цифры, подчёркивание. */
export const githubTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, 'токен слишком короткий')
    .max(255, 'токен слишком длинный')
    .regex(/^[A-Za-z0-9_]+$/u, 'токен записан неверно: допустимы буквы, цифры и подчёркивание'),
});

/** Повторное подтверждение перед опасным действием над копией (ADR-0086): пароль и, если подключён, код. */
export const sensitiveConfirmSchema = z.object({
  password: z.string().min(1, 'введите пароль').max(200),
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/u, 'код — шесть цифр')
    .optional(),
});

export const backupTargetSchema = z.object({
  id: z.string().max(200),
});

/** Восстановление: то же подтверждение плюс слово — случайное нажатие стирает рабочую базу. */
export const RESTORE_PHRASE = 'ВОССТАНОВИТЬ';
export const restoreSchema = backupTargetSchema.extend({
  ...sensitiveConfirmSchema.shape,
  phrase: z.literal(RESTORE_PHRASE, { error: `введите слово ${RESTORE_PHRASE}` }),
});
