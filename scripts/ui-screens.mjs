/**
 * Снимки экранов кабинета с автоматическими находками: `pnpm ui:screens`.
 *
 * Отвечает на вопрос, которого не закрывает гейт, — **удобен ли** кабинет, а не только
 * «оживает ли». Обходит разделы каждой роли на ширине 1280 и 390 в светлой и тёмной теме
 * и пишет отчёт `test-results/ui-screens/report.md`: ошибки консоли и отказы API на странице,
 * горизонтальную прокрутку, выпирающие блоки, мелкие цели нажатия, невидимый фокус,
 * нарушения доступности по axe и расхождение со снятым эталоном.
 * Используется навыком `ui-review` ([.claude/skills/ui-review/SKILL.md](../.claude/skills/ui-review/SKILL.md)).
 *
 *   pnpm ui:screens                      обход и отчёт
 *   pnpm ui:screens --update-snapshots   то же и снять эталоны заново
 *   pnpm ui:screens --serve              поднять стенд с данными и ждать Ctrl+C
 *
 * Остальные аргументы уходят Playwright как есть (например, `-g partner`).
 * Нужны собранные API и кабинет (`pnpm build`, `pnpm web:build`) и браузер Playwright.
 *
 * **Сбрасывает тестовую базу**, как и шаг «Кабинет в браузере»: стенд тот же
 * ([e2e-stack.mjs](e2e-stack.mjs)). Наполнение стенда даёт учётные записи, но не оборудование
 * и не деньги — без них проверялись бы пустые экраны, поэтому данные доводятся здесь, через
 * API администратором. Имена, суммы и ключи идемпотентности постоянные: эталон снимка
 * сравним между прогонами, только пока одинаковы данные.
 *
 * В гейт не входит: эталон зависит от шрифтов и системы и лежит вне git (`.ui-baseline/`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { E2E_PASSWORD, STACK_ENV, startStack, TEST_DATABASE_URL } from './e2e-stack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results', 'ui-screens');
const FINDINGS = path.join(OUT, 'findings.jsonl');
const REPORT = path.join(OUT, 'report.md');
const NOT_RUN = 78;

const SERVE = process.argv.includes('--serve');
const PASSTHROUGH = process.argv.slice(2).filter((argument) => argument !== '--serve');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const output = [];
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: output.join('') });
    });
  });
}

/** Тот же ответ на «есть ли браузер», что в `e2e.mjs`: попытка запуска, а не каталог. */
async function browserReady() {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Данные, без которых экраны пусты: шлюз с восемью портами и SIM, цена, наценка,
 * пополнение и линия с очень длинным названием — проверить обрезку текста.
 * Каждое обращение обязано пройти: половина данных — это экран, проверенный наполовину.
 */
async function populate(apiUrl) {
  let token;
  const call = async (method, url, body) => {
    const response = await fetch(`${apiUrl}${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${url} → ${String(response.status)}: ${text.slice(0, 300)}`);
    }
    return text === '' ? {} : JSON.parse(text);
  };
  const firstList = (value) => Object.values(value).find(Array.isArray) ?? [];

  ({ token } = await call('POST', '/auth/login', {
    email: 'admin@e2e.zvonix.test',
    password: E2E_PASSWORD,
  }));
  const partnerId = firstList(await call('GET', '/partners'))[0]?.id;
  const clientId = firstList(await call('GET', '/clients'))[0]?.id;
  // Оператора заводит наполнение стенда; второй с тем же именем получил бы отказ.
  const operatorId = firstList(await call('GET', '/operators')).find(
    (row) => row.name === 'МегаФон',
  )?.id;
  if (partnerId === undefined || clientId === undefined || operatorId === undefined) {
    throw new Error('Наполнение стенда не дало партнёра, клиента или оператора «МегаФон»');
  }

  const { gateway } = await call('POST', '/gateways', {
    partnerId,
    name: 'GOIP в гараже на улице Длинного Названия дом 118 корпус 4',
    type: 'goip',
  });
  await call('POST', `/gateways/${gateway.id}/status`, { status: 'active' });
  for (let slot = 1; slot <= 8; slot += 1) {
    const { port } = await call('POST', `/gateways/${gateway.id}/ports`, { portNumber: slot });
    const { sim } = await call('POST', '/sim-cards', {
      partnerId,
      operatorId,
      msisdn: `7916${String(1_000_000 + slot)}`,
    });
    await call('POST', `/sim-cards/${sim.id}/status`, { status: 'active' });
    await call('POST', `/gateway-ports/${port.id}/sim`, { simCardId: sim.id });
  }
  await call('POST', '/partner-rates', {
    partnerId,
    operatorId,
    pricePerMinute: '1.25',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await call('POST', '/commission-rules', {
    clientId,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await call('POST', `/clients/${clientId}/deposit`, {
    amount: '1500.5',
    idempotencyKey: 'ui-screens-deposit',
    description: 'Пополнение под проверку интерфейса',
  });
  await call('POST', '/channels', {
    clientId,
    name: 'Диспетчерская ночной смены с очень длинным названием для проверки обрезки текста',
  });
}

/** Сводка находок в человекочитаемом виде: сначала то, что чинится до готовности. */
function writeReport(code) {
  const rows = existsSync(FINDINGS)
    ? readFileSync(FINDINGS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const hard = rows.filter((row) => row.weight === 'дефект');
  const soft = rows.filter((row) => row.weight === 'кандидат');
  const line = (row) => `- \`${row.where}\` — ${row.what}${row.detail ? `: ${row.detail}` : ''}`;
  const text = [
    '# Снимки экранов кабинета',
    '',
    `Прогон ${new Date().toISOString()}, код Playwright ${String(code)}.`,
    `Снимки — \`test-results/ui-screens/shots/\`; эталоны — \`.ui-baseline/\`.`,
    '',
    `## Дефекты: ${String(hard.length)}`,
    '',
    ...(hard.length === 0 ? ['Нет.'] : hard.map(line)),
    '',
    `## Кандидаты — смотреть глазами: ${String(soft.length)}`,
    '',
    ...(soft.length === 0 ? ['Нет.'] : soft.map(line)),
    '',
  ].join('\n');
  writeFileSync(REPORT, text);
  return { hard: hard.length, soft: soft.length };
}

async function main() {
  if (!(await browserReady())) {
    process.stdout.write(
      'Браузер Playwright не установлен — снимки не сняты.\n' +
        'Поставить: pnpm exec playwright install chromium\n',
    );
    return NOT_RUN;
  }

  process.stdout.write('Готовим базу и наполняем стенд…\n');
  const seeded = await run(process.execPath, [path.join('dist', 'testing', 'seed-e2e.js')], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, ...STACK_ENV, DATABASE_URL: TEST_DATABASE_URL },
  });
  if (seeded.code !== 0) {
    process.stderr.write(`Наполнение стенда не удалось:\n${seeded.output}\n`);
    return 1;
  }

  process.stdout.write('Поднимаем кабинет и API…\n');
  const stack = await startStack();
  try {
    process.stdout.write('Заводим оборудование, цены и деньги…\n');
    await populate(stack.apiUrl);

    if (SERVE) {
      process.stdout.write(
        `\nСтенд поднят: ${stack.baseUrl}\n` +
          'Входы: admin@e2e.zvonix.test, support@e2e.zvonix.test, client@e2e.zvonix.test, both@e2e.zvonix.test (два кабинета), ' +
          `partner@e2e.zvonix.test — пароль «${E2E_PASSWORD}».\n` +
          'Заходить именно по этому адресу: сессия живёт в cookie на источник.\n' +
          'Остановить — Ctrl+C.\n',
      );
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      return 0;
    }

    const result = await run(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        'playwright.screens.config.ts',
        ...PASSTHROUGH,
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: stack.baseUrl, E2E_PASSWORD },
      },
    );
    const { hard, soft } = writeReport(result.code);
    process.stdout.write(
      `\nДефектов: ${String(hard)}, кандидатов: ${String(soft)}. ` +
        `Отчёт — ${path.relative(ROOT, REPORT)}\n`,
    );
    if (result.code !== 0) {
      process.stderr.write(`Playwright завершился с кодом ${String(result.code)}.\n`);
      process.stderr.write(`Вывод стенда:\n${stack.output.join('').slice(-4000)}\n`);
      return result.code;
    }
    // Находки не роняют проход в Playwright — иначе первая скрыла бы остальные страницы, —
    // поэтому исход назначается здесь: дефект есть — обход не пройден (замер 2026-09-22:
    // первая версия при 47 дефектах возвращала 0).
    return hard > 0 ? 1 : 0;
  } finally {
    await stack.stop();
  }
}

process.exitCode = await main().catch((error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\nСнимки экранов прерваны: ${detail}\n`);
  return 1;
});
