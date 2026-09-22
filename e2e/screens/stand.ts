/**
 * Общее для обхода экранов: роли, пути, запись находок и проверки страницы.
 *
 * У находки два веса, как в навыке `ui-review`:
 * - **дефект** — чинится до готовности: ошибка консоли, отказ API на странице, прокрутка
 *   страницы вбок, серьёзное нарушение доступности, окно, которое не влезает или не
 *   закрывается;
 * - **кандидат** — смотреть глазами: мелкая цель, выпирающий блок, невидимый фокус,
 *   несовпадение с эталоном. Автомат их находит, но судить, дефект ли это, — человеку.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const ROLES = ['admin', 'support', 'client', 'partner'] as const;
export type Role = (typeof ROLES)[number];

const OUT = path.resolve(import.meta.dirname, '..', '..', 'test-results', 'ui-screens');
export const SHOTS_DIR = path.join(OUT, 'shots');
const AUTH_DIR = path.join(OUT, '.auth');
export const PAGES_FILE = path.join(AUTH_DIR, 'pages.json');
const FINDINGS_FILE = path.join(OUT, 'findings.jsonl');

export const authFile = (role: Role): string => path.join(AUTH_DIR, `${role}.json`);

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readPages(): Record<Role, { home: string; routes: string[] }> {
  return JSON.parse(readFileSync(PAGES_FILE, 'utf8')) as Record<
    Role,
    { home: string; routes: string[] }
  >;
}

export type Weight = 'дефект' | 'кандидат';

/** Находка — строкой в общий файл; сводку из них собирает `scripts/ui-screens.mjs`. */
export function record(weight: Weight, where: string, what: string, detail = ''): void {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(FINDINGS_FILE, `${JSON.stringify({ weight, where, what, detail })}\n`);
}

/**
 * Изменчивое на экране — то, что между прогонами разное при тех же данных:
 * - момент до секунды (`lib/format.ts`, `moment`);
 * - идентификатор записи: это UUIDv7, в нём время заведения (журнал действий показывает
 *   его у каждой строки — первый прогон 2026-09-22).
 * Закрывается маской в эталоне, иначе каждый снимок «не совпадал» бы по времени
 * заведения записи.
 */
export function volatile(page: Page) {
  return [
    page.getByText(/\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/u),
    page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u),
    page.locator('[data-ui-volatile]'),
  ];
}

/** Раскладка: прокрутка вбок, выпирающие блоки, цели нажатия меньше 24×24 (WCAG 2.2, 2.5.8). */
export async function layout(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (element: Element): string => {
      const classes =
        typeof element.className === 'string' && element.className.trim() !== ''
          ? `.${element.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
          : '';
      const text = element.textContent.trim().replace(/\s+/gu, ' ').slice(0, 30);
      return `${element.tagName.toLowerCase()}${classes}${text === '' ? '' : ` «${text}»`}`;
    };

    // Выпирает то, что уходит за край и не лежит в своём прокручиваемом блоке:
    // широкая таблица в `overflow-x: auto` допустима, страница целиком — нет.
    const sticking = new Set<Element>();
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= vw + 1) continue;
      let contained = false;
      for (let parent = element.parentElement; parent !== null && parent !== document.body;) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (
          /auto|scroll|hidden|clip/u.test(overflowX) &&
          parent.getBoundingClientRect().right <= vw + 1
        ) {
          contained = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!contained) sticking.add(element);
    }
    const overflow = [...sticking]
      .filter((element) => element.parentElement === null || !sticking.has(element.parentElement))
      .slice(0, 5)
      .map(describe);

    const small: string[] = [];
    const targets = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="tab"]',
    );
    for (const element of targets) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // Исключение 2.5.8: ссылка внутри строки текста.
      if (element.tagName === 'A' && element.closest('p, li') !== null) continue;
      if (box.width < 24 || box.height < 24) {
        small.push(
          `${describe(element)} ${String(Math.round(box.width))}×${String(Math.round(box.height))}`,
        );
      }
    }

    return {
      horizontalScroll: document.documentElement.scrollWidth > vw + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: vw,
      overflow,
      small,
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
}

/** Виден ли фокус: пятнадцать нажатий Tab и контур или тень у каждого получившего его. */
export async function invisibleFocus(page: Page): Promise<{ tabbed: number; invisible: string[] }> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let tabbed = 0;
  const invisible: string[] = [];
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press('Tab');
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;
      const style = getComputedStyle(element);
      const visible =
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none';
      const text = element.textContent.trim();
      const name = text === '' ? (element.getAttribute('aria-label') ?? '') : text;
      return { visible, name: `${element.tagName.toLowerCase()} «${name.slice(0, 25)}»` };
    });
    if (state === null) continue;
    tabbed += 1;
    if (!state.visible && !invisible.includes(state.name)) invisible.push(state.name);
  }
  // Фокус снимается: иначе рамка на поле попадала бы в снимок одной темы и не другой.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  return { tabbed, invisible };
}

/** Нарушения доступности по axe: правила WCAG 2.0–2.2, уровни A и AA. */
export async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.map((violation) => ({
    serious: violation.impact === 'critical' || violation.impact === 'serious',
    detail:
      `${violation.id} (${violation.impact ?? '?'}) — ${violation.help}; ` +
      `мест: ${String(violation.nodes.length)}, например ` +
      violation.nodes
        .slice(0, 2)
        .map((node) => node.target.join(' '))
        .join('; '),
  }));
}

/** Снимок во всю высоту; Chromium на Windows иногда отказывает — тогда видимая часть. */
export async function screenshot(page: Page, file: string): Promise<string | null> {
  const options = {
    path: file,
    animations: 'disabled',
    caret: 'hide',
    mask: volatile(page),
  } as const;
  try {
    await page.screenshot({ ...options, fullPage: true, timeout: 20_000 });
    return null;
  } catch (error) {
    await page.screenshot({ ...options, timeout: 20_000 });
    return String(error).split('\n')[0] ?? 'снимок во всю высоту не удался';
  }
}
