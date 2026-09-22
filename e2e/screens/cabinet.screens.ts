/**
 * Обход экранов кабинета: каждая роль, ширины 1280 и 390, светлая и тёмная тема.
 *
 * Правила — из навыка `ui-review` и [DESIGN.md](../../docs/DESIGN.md): страница целиком
 * вбок не прокручивается, отказ API на странице — дефект (так 2026-09-14 нашлось, что
 * партнёр не может завести SIM), фокус виден, первый экран партнёра на телефоне показывает
 * SIM и деньги. Находки пишутся в файл, а не роняют проход: иначе первый же дефект
 * скрыл бы все следующие страницы.
 *
 * Окна подтверждения проверяются **последними**: одно из них заводит ключ API, и снимки,
 * снятые после него, отличались бы от эталона на эту строку.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  accessibility,
  authFile,
  invisibleFocus,
  layout,
  readPages,
  record,
  ROLES,
  screenshot,
  SHOTS_DIR,
  volatile,
  type Role,
} from './stand.js';

const SIZES = [
  { width: 1280, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
] as const;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** Тема выбирается так же, как её выбирает человек: запись в хранилище до загрузки. */
async function chooseTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('zvonix.theme', value);
    } catch {
      // Хранилище закрыто — тема останется системной, и проверка темы ниже это назовёт.
    }
  }, theme);
}

/** Ошибки консоли и отказы API, пойманные на текущей странице. */
function listen(page: Page) {
  const errors: string[] = [];
  const refused: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => errors.push(`исключение: ${error.message.slice(0, 200)}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      refused.push(`${String(response.status())} ${new URL(response.url()).pathname}`);
    }
  });
  return {
    errors,
    refused,
    reset() {
      errors.length = 0;
      refused.length = 0;
    },
  };
}

for (const role of ROLES) {
  for (const size of SIZES) {
    for (const theme of THEMES) {
      test.describe(`${role} @${String(size.width)} ${theme}`, () => {
        test.use({
          storageState: authFile(role),
          viewport: { width: size.width, height: size.height },
          isMobile: size.mobile,
          hasTouch: size.mobile,
        });

        test('разделы', async ({ page }, testInfo) => {
          const { home, routes } = readPages()[role];
          await chooseTheme(page, theme);
          const seen = listen(page);
          const updating = testInfo.config.updateSnapshots !== 'none';

          for (const route of routes) {
            const where = `${role} ${route} @${String(size.width)}, ${theme}`;
            await test.step(route, async () => {
              seen.reset();
              try {
                await page.goto(route);
                // Сеть успокоилась — данные пришли; не успокоилась за 15 с — снимаем как есть,
                // а зависший запрос сам попадёт в находки через отказ или ошибку.
                await page
                  .waitForLoadState('networkidle', { timeout: 15_000 })
                  .catch(() => undefined);
              } catch (error) {
                record('дефект', where, 'страница не открылась', String(error).split('\n')[0]);
                return;
              }

              const found = await layout(page);
              if (found.theme !== theme) {
                record(
                  'дефект',
                  where,
                  'тема не применилась',
                  `data-theme = ${String(found.theme)}`,
                );
              }
              if (found.horizontalScroll) {
                record(
                  'дефект',
                  where,
                  'страница прокручивается вбок',
                  `ширина ${String(found.scrollWidth)} при окне ${String(found.viewportWidth)}; ` +
                    found.overflow.join('; '),
                );
              } else if (found.overflow.length > 0) {
                record('кандидат', where, 'блок выходит за край окна', found.overflow.join('; '));
              }
              if (found.small.length > 0) {
                record(
                  'кандидат',
                  where,
                  `цели меньше 24×24: ${String(found.small.length)}`,
                  found.small.slice(0, 4).join('; '),
                );
              }

              for (const violation of await accessibility(page)) {
                record(
                  violation.serious ? 'дефект' : 'кандидат',
                  where,
                  'доступность',
                  violation.detail,
                );
              }

              if (!size.mobile && theme === 'light') {
                const focus = await invisibleFocus(page);
                if (focus.invisible.length > 0) {
                  record(
                    'кандидат',
                    where,
                    `фокус не виден: ${String(focus.invisible.length)} из ${String(focus.tabbed)}`,
                    focus.invisible.slice(0, 4).join('; '),
                  );
                }
              }

              // DESIGN.md, «Три аудитории»: партнёр смотрит с телефона, и состояние SIM
              // и деньги должны быть на первом экране без прокрутки.
              if (role === 'partner' && size.mobile && route === home) {
                const firstScreen = await page.evaluate(() =>
                  [...document.querySelectorAll('body *')]
                    .filter((element) => {
                      const box = element.getBoundingClientRect();
                      return (
                        element.children.length === 0 && box.top < innerHeight && box.bottom > 0
                      );
                    })
                    .map((element) => element.textContent)
                    .join(' '),
                );
                if (!/SIM|карт/iu.test(firstScreen) || !/₽/u.test(firstScreen)) {
                  record('кандидат', where, 'на первом экране партнёра нет SIM или денег');
                }
              }

              const name = `${role}${route.replaceAll('/', '_')}-${String(size.width)}-${theme}.png`;
              const fallback = await screenshot(page, path.join(SHOTS_DIR, name));
              if (fallback !== null) {
                record('кандидат', where, 'снят только видимый кусок', fallback.slice(0, 160));
              }
              if (updating || existsSync(testInfo.snapshotPath(name))) {
                const before = testInfo.errors.length;
                await expect
                  .soft(page, `снимок ${where}`)
                  .toHaveScreenshot(name, { fullPage: true, mask: volatile(page) });
                if (!updating && testInfo.errors.length > before) {
                  record(
                    'кандидат',
                    where,
                    'отличается от эталона',
                    'разница — в test-results/ui-screens; задумано — снять заново: pnpm ui:screens --update-snapshots',
                  );
                }
              } else {
                record(
                  'кандидат',
                  where,
                  'эталона нет',
                  'снять: pnpm ui:screens --update-snapshots',
                );
              }

              for (const error of seen.errors) record('дефект', where, 'ошибка консоли', error);
              for (const refusal of new Set(seen.refused)) {
                record('дефект', where, 'отказ API на странице', refusal);
              }
            });
          }
        });
      });
    }
  }
}

/**
 * Окно подтверждения на телефоне: влезает, забирает фокус, закрывается Escape — ничего
 * не выполняя. Способ открыть окно у каждой роли свой; сценарий, переставший открывать
 * окно, — кандидат, а не дефект: скорее устарел сценарий, чем сломался экран.
 */
const DIALOGS: Partial<Record<Role, { route: string; open: (page: Page) => Promise<void> }>> = {
  admin: {
    route: '/tariffs',
    open: async (page) => {
      await page.getByRole('button', { name: 'Добавить правило' }).click();
      await page.getByLabel('Доля, %').fill('12,5');
      await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    },
  },
  client: {
    route: '/my/integration',
    open: async (page) => {
      await page.getByRole('button', { name: 'Завести ключ' }).click();
      await page.getByLabel('Назначение').fill('Ключ для проверки окна');
      await page.getByRole('button', { name: 'Завести', exact: true }).click();
      await page.getByRole('button', { name: 'Отозвать' }).first().click();
    },
  },
  partner: {
    route: '/partner/equipment',
    open: async (page) => {
      await page
        .getByRole('region', { name: /GOIP в гараже/u })
        .getByRole('button', { name: 'Списать' })
        .first()
        .click();
    },
  },
};

for (const [role, dialog] of Object.entries(DIALOGS) as [
  Role,
  NonNullable<(typeof DIALOGS)[Role]>,
][]) {
  for (const theme of THEMES) {
    test.describe(`окно подтверждения: ${role} @390 ${theme}`, () => {
      test.use({
        storageState: authFile(role),
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });

      test('влезает, держит фокус, закрывается', async ({ page }) => {
        const where = `окно ${role} ${dialog.route} @390, ${theme}`;
        await chooseTheme(page, theme);
        await page.goto(dialog.route);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        try {
          await dialog.open(page);
          await page.getByRole('alertdialog').waitFor({ timeout: 10_000 });
        } catch (error) {
          record(
            'кандидат',
            where,
            'окно не открылось — сценарий устарел?',
            String(error).split('\n')[0],
          );
          return;
        }

        const box = await page.getByRole('alertdialog').boundingBox();
        await screenshot(page, path.join(SHOTS_DIR, `dialog-${role}-390-${theme}.png`));
        const fits =
          box !== null &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= 391 &&
          box.y + box.height <= 845;
        if (!fits) record('дефект', where, 'окно не влезает в экран', JSON.stringify(box));
        const focusInside = await page.evaluate(() =>
          Boolean(document.activeElement?.closest('[role="alertdialog"]')),
        );
        if (!focusInside) record('дефект', where, 'фокус остался под окном');
        await page.keyboard.press('Escape');
        const closed = await page
          .getByRole('alertdialog')
          .waitFor({ state: 'detached', timeout: 5_000 })
          .then(
            () => true,
            () => false,
          );
        if (!closed) record('дефект', where, 'Escape не закрывает окно');
      });
    });
  }
}
