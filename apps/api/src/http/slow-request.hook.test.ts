import { createLogger } from '@zvonix/logger';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSlowRequestLog } from './slow-request.hook.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(thresholdMs: number) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: 'debug', format: 'json', component: 'api', base: { app: 'zvonix' } },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const app = Fastify();
  apps.push(app);
  registerSlowRequestLog(app, logger, thresholdMs);
  app.get('/client/messages/:id', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true };
  });
  await app.ready();
  return { app, lines };
}

describe('журнал медленных запросов', () => {
  it('дольше порога — предупреждение с шаблоном маршрута, без самого адреса', async () => {
    const { app, lines } = await setup(10);
    await app.inject({ method: 'GET', url: '/client/messages/79001234567' });
    const warning = lines.find((line) => line['message'] === 'Медленный запрос');
    expect(warning).toMatchObject({
      level: 'warn',
      component: 'http',
      method: 'GET',
      route: '/client/messages/:id',
      status: 200,
    });
    expect(Number(warning?.['duration_ms'])).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(lines)).not.toContain('79001234567');
  });

  it('быстрее порога — ничего не пишется', async () => {
    const { app, lines } = await setup(60_000);
    await app.inject({ method: 'GET', url: '/client/messages/1' });
    expect(lines.filter((line) => line['message'] === 'Медленный запрос')).toHaveLength(0);
  });
});
