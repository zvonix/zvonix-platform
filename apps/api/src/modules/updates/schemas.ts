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
