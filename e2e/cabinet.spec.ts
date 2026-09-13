/**
 * Кабинет в настоящем браузере.
 *
 * Отвечает на то, что не закрывает ни один другой шаг проверки: **оживает ли
 * страница**. Типы, линтер и сборка бывают зелёными у кабинета, который отдаётся
 * и не работает, — так уже было с источником запросов (`127.0.0.1` против
 * `localhost`): страница приходила, а формы отправлялись браузером мимо кабинета.
 *
 * Проверяется то, что видно только отсюда: сессия в cookie `HttpOnly`
 * ([ADR-0037](../docs/adr/0037-sessiya-v-brauzere.md)), разводка по ролям
 * и правило «действие, недоступное роли, не рисуется»
 * ([DESIGN.md](../docs/DESIGN.md)). Права как таковые проверяет API — здесь
 * проверяется, что человек их видит.
 */

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

const PEOPLE = {
  admin: 'admin@e2e.zvonix.test',
  support: 'support@e2e.zvonix.test',
  client: 'client@e2e.zvonix.test',
  partner: 'partner@e2e.zvonix.test',
} as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Адрес почты').fill(email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  // Вход завершён, когда страница входа сменилась: у каждой роли свой первый раздел.
  await expect(page).not.toHaveURL(/\/login/u);
}

test.describe('вход', () => {
  test('неверный пароль не пускает и говорит об этом', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Адрес почты').fill(PEOPLE.admin);
    await page.getByLabel('Пароль').fill('не-тот-пароль-совсем');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('Неверный адрес или пароль')).toBeVisible();
    await expect(page).toHaveURL(/\/login/u);
  });

  test('сессия живёт в cookie, недоступной сценарию', async ({ page, context }) => {
    await signIn(page, PEOPLE.admin);

    const session = (await context.cookies()).find((cookie) => cookie.name.includes('zvonix'));
    expect(session, 'cookie сессии не выдана').toBeDefined();
    // `HttpOnly` — то, ради чего сессию и унесли из хранилища браузера: украденный
    // сценарий не должен уметь её прочитать (ADR-0037).
    expect(session?.httpOnly).toBe(true);

    // И проверка с другой стороны: из страницы её действительно не видно.
    expect(await page.evaluate(() => document.cookie)).not.toContain('zvonix');
  });

  test('выход возвращает на страницу входа', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/u);
  });
});

test.describe('разводка по ролям', () => {
  const homes: [keyof typeof PEOPLE, RegExp][] = [
    ['admin', /\/calls$/u],
    ['support', /\/calls$/u],
    ['client', /\/my\/calls$/u],
    ['partner', /\/partner\/calls$/u],
  ];

  for (const [role, home] of homes) {
    test(`${role} попадает в свой первый раздел`, async ({ page }) => {
      await signIn(page, PEOPLE[role]);
      await expect(page).toHaveURL(home);
    });
  }
});

test.describe('поддержка видит, но не меняет', () => {
  test('разделы открыты — включая те, что раньше были закрыты целиком', async ({ page }) => {
    await signIn(page, PEOPLE.support);

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    for (const label of [
      'Учётные записи',
      'Партнёры и оборудование',
      'Клиенты и деньги',
      'Тарифы и наценка',
      'Разбор вызовов',
    ]) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible();
    }

    // Настройки площадки закрыты и останутся: там секреты, и обработчик чтения
    // у них помечен ролью администратора (ADR-0041 к этому отношения не имеет).
    await expect(rail.getByRole('link', { name: 'Настройки площадки' })).toHaveCount(0);
  });

  test('на партнёрах нет действий, но есть данные и отметка «только чтение»', async ({ page }) => {
    await signIn(page, PEOPLE.support);
    await page.goto('/partners');

    await expect(page.getByText('Только чтение:')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Завести партнёра' })).toHaveCount(0);
    // Данные при этом на месте: раздел открыт целиком, а не наполовину.
    await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
  });

  test('администратор на том же экране действие видит', async ({ page }) => {
    // Обратная половина: если бы кнопки не было ни у кого, предыдущая проверка
    // проходила бы и на сломанном экране.
    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');

    await expect(page.getByRole('button', { name: 'Завести партнёра' })).toBeVisible();
    await expect(page.getByText('Только чтение:')).toHaveCount(0);
  });
});

test.describe('чужой раздел', () => {
  test('клиент, зайдя в админский раздел, видит объяснение, а не пустоту', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/partners');

    // По тексту, а не по роли: Next держит на странице собственный объявитель
    // маршрута с той же ролью `alert`, и отбор по роли находит оба.
    await expect(page.getByText('Раздел доступен')).toBeVisible();
  });

  test('партнёр видит свои разделы и своё состояние', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/money');

    await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
    await expect(page.getByText('Партнёр 17')).toBeVisible();
    // Заработка ещё нет, и это нормальное состояние нового партнёра.
    await expect(page.getByText('Заработано, к выплате')).toBeVisible();
  });
});

test.describe('кабинет клиента', () => {
  test('свои линии перечисляются — до этого их взять было неоткуда', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/channels');

    await expect(page.getByText('Диспетчерская')).toBeVisible();
  });
});

test.describe('ввод денег', () => {
  // Идёт последним: единственная проверка, которая **меняет** состояние стенда.
  test('копейки набираются запятой — той же, с какой кабинет их показывает', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/tariffs');

    await page.getByRole('button', { name: 'Добавить правило' }).click();
    await page.getByLabel('Доля, %').fill('5');
    await page.getByLabel('Фикс за вызов, ₽').fill('0,1');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    // Десять копеек, а не рубль и не отказ проверки: перевод в машинный вид —
    // работа кабинета, а не человека.
    await expect(page.getByRole('table').getByText(/0,1/u)).toBeVisible();
  });
});

test.describe('клиент заводит доступ своей системе', () => {
  test('секрет ключа приходит там же, где его вставят в диспетчерскую', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    // До ADR-0044 ключ выпускал администратор, и секрет обязан был дойти до клиента
    // перепиской. Теперь он появляется там же, где его и вставляют.
    await page.getByRole('button', { name: 'Завести ключ' }).click();
    await page.getByLabel('Назначение').fill('Диспетчерская на проверке');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();

    await expect(page.getByText('Ключ «Диспетчерская на проверке»')).toBeVisible();
    await expect(page.getByText(/zvx_client_/u).first()).toBeVisible();
  });

  test('отзыв спрашивает второй раз: ключ после него не оживить', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    await page.getByRole('button', { name: 'Завести ключ' }).click();
    await page.getByLabel('Назначение').fill('Ключ на отзыв');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();
    await expect(page.getByText('Ключ «Ключ на отзыв»')).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: 'Ключ на отзыв' });
    await row.getByRole('button', { name: 'Отозвать' }).click();
    await expect(row.getByRole('button', { name: 'Точно отозвать?' })).toBeVisible();
    await row.getByRole('button', { name: 'Точно отозвать?' }).click();

    await expect(row.getByText(/отозван/u)).toBeVisible();
  });
});

test.describe('партнёр заводит своё оборудование', () => {
  test('заводит шлюз и получает пароль SIP там же, где его вводит', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    // До ADR-0043 здесь стояло «состав оборудования меняет администратор», и завести
    // шлюз партнёр не мог ничем: ни кнопки, ни обработчика.
    await page.getByRole('button', { name: 'Завести шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP на проверке');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();

    // Пароль показывается один раз и приходит туда же, где партнёр настраивает железо.
    await expect(page.getByText('Доступ для этого шлюза')).toBeVisible();
    await expect(page.getByText('GOIP на проверке')).toBeVisible();
  });

  test('списание спрашивает второй раз: отменить его будет нечем', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Завести шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на списание');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();
    await expect(page.getByText('Шлюз на списание')).toBeVisible();

    // Первый нажим спрашивает, второй делает: списание стоит рядом с «выключить»,
    // которое отменяется одним нажатием, и разница должна быть видна пальцу.
    const card = page.getByRole('region', { name: 'Шлюз на списание' });
    await card.getByRole('button', { name: 'Списать' }).click();
    await expect(card.getByRole('button', { name: 'Точно списать?' })).toBeVisible();
    await card.getByRole('button', { name: 'Точно списать?' }).click();

    await expect(page.getByRole('region', { name: 'Шлюз на списание' })).toHaveCount(0);
  });
});
