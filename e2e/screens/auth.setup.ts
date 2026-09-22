/**
 * Подготовка обхода: вход каждой ролью и список её разделов.
 *
 * Сессия сохраняется в файл, и обход открывает страницы уже вошедшим: иначе каждый
 * из шестнадцати проходов входил бы заново, и половина времени уходила бы на форму входа.
 *
 * Разделы берутся **из меню роли**, а не из списка здесь: новый раздел кабинета попадает
 * в обход сам, а список, переписанный руками, отстал бы от меню при первой же правке.
 */

import { expect, test } from '@playwright/test';
import { authFile, PAGES_FILE, ROLES, writeJson } from './stand.js';

const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

test('вход ролями и разделы из меню', async ({ browser, baseURL, locale }) => {
  const pages: Record<string, { home: string; routes: string[] }> = {};

  for (const role of ROLES) {
    // Свой контекст на роль: у `browser.newContext` нет настроек проекта — адрес стенда
    // и локаль передаются явно.
    const context = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(locale === undefined ? {} : { locale }),
    });
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Адрес почты').fill(`${role}@e2e.zvonix.test`);
    await page.getByLabel('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).not.toHaveURL(/\/login/u);

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByRole('link').first()).toBeVisible();
    const hrefs = await rail
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    const routes = [...new Set(hrefs.filter((href) => href.startsWith('/')))];
    expect(routes.length, `у роли ${role} в меню нет разделов`).toBeGreaterThan(0);

    pages[role] = { home: new URL(page.url()).pathname, routes };
    await context.storageState({ path: authFile(role) });
    await context.close();
  }

  writeJson(PAGES_FILE, pages);
});
