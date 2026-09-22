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
  // Меняет состояние стенда — поэтому после проверок, которые только читают.
  test('копейки набираются запятой — той же, с какой кабинет их показывает', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/tariffs');

    await page.getByRole('button', { name: 'Добавить правило' }).click();
    await page.getByLabel('Доля, %').fill('5');
    await page.getByLabel('Фикс за вызов, ₽').fill('0,1');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    // Правило без клиента ложится на всех, у кого нет своего, — окно говорит это до нажатия.
    // Раньше заранее заполненная форма заводила наценку на всю площадку с первого щелчка.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('для всех клиентов');
    await dialog.getByRole('button', { name: 'Добавить правило' }).click();
    await expect(dialog).toHaveCount(0);

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

  test('отзыв спрашивает и отменяется: ключ после него не оживить', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    await page.getByRole('button', { name: 'Завести ключ' }).click();
    await page.getByLabel('Назначение').fill('Ключ на отзыв');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();
    await expect(page.getByText('Ключ «Ключ на отзыв»')).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: 'Ключ на отзыв' });
    const dialog = page.getByRole('alertdialog', { name: 'Отозвать ключ «Ключ на отзыв»' });

    // Escape отменяет, и ключ жив. Прежняя взведённая кнопка «Точно отозвать?»
    // не сбрасывалась ничем, и следующий щелчок отзывал ключ уже без вопроса.
    await row.getByRole('button', { name: 'Отозвать' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText(/отозван/u)).toHaveCount(0);

    await row.getByRole('button', { name: 'Отозвать' }).click();
    await dialog.getByRole('button', { name: 'Отозвать ключ' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(row.getByText(/отозван/u)).toBeVisible();
    // Кнопки «Отозвать» у ключа больше нет, но фокус не падает на страницу (ConfirmAction).
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body))
      .toBe(false);
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

  test('заводит SIM: справочник операторов ему открыт', async ({ page }) => {
    // Форма брала операторов из `GET /operators`, закрытого партнёру: `403` на каждом
    // открытии раздела и пустой выбор, с которым SIM не завести (ui-review, 2026-09-14).
    const denied: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403) denied.push(response.url());
    });

    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Завести SIM' }).click();
    await page.getByLabel('Номер карты').fill('+7 913 555-00-17');
    await page.getByLabel('Оператор').selectOption({ label: 'МегаФон' });
    await page.getByRole('button', { name: 'Завести', exact: true }).click();

    // Источник оператора на стенде выключен: карта заводится и ждёт подтверждения.
    await expect(
      page.getByRole('row').filter({ hasText: '9135550017' }).filter({ hasText: 'МегаФон' }),
    ).toBeVisible();
    expect(denied).toEqual([]);
  });

  test('выключенный собой шлюз партнёр включает обратно здесь же', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Завести шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на выключение');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();

    const card = page.getByRole('region', { name: 'Шлюз на выключение' });
    await card.getByRole('button', { name: 'Включить' }).click();
    await expect(card.getByText('Работает', { exact: true })).toBeVisible();

    // До ADR-0047 выключение партнёра не отличалось от отключения площадкой,
    // и за одной кнопкой «Включить» приходилось идти к администратору.
    const dialog = page.getByRole('alertdialog', { name: 'Выключить шлюз «Шлюз на выключение»' });
    await card.getByRole('button', { name: 'Выключить' }).click();
    await expect(dialog).toContainText('обратно');
    await dialog.getByRole('button', { name: 'Выключить шлюз' }).click();

    await expect(card.getByText('Выключен вами')).toBeVisible();
    await card.getByRole('button', { name: 'Включить' }).click();
    await expect(card.getByText('Работает', { exact: true })).toBeVisible();
  });

  test('списание спрашивает с последствием: отменить его будет нечем', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Завести шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на списание');
    await page.getByRole('button', { name: 'Завести', exact: true }).click();
    await expect(page.getByText('Шлюз на списание')).toBeVisible();

    // Окно называет последствие, а не «вы уверены?»: списание стоит рядом с «выключить»,
    // которое отменяется одним нажатием, и разница должна быть видна до нажатия.
    const card = page.getByRole('region', { name: 'Шлюз на списание' });
    const dialog = page.getByRole('alertdialog', { name: 'Списать шлюз «Шлюз на списание»' });
    await card.getByRole('button', { name: 'Списать' }).click();
    await expect(dialog).toContainText('навсегда');
    await dialog.getByRole('button', { name: 'Списать шлюз' }).click();

    await expect(page.getByRole('region', { name: 'Шлюз на списание' })).toHaveCount(0);
    // Кнопка «Списать» ушла вместе со шлюзом, но фокус не падает на страницу: он встаёт
    // на ближайший доступный элемент там, где кнопка стояла (ConfirmAction).
    await expect(page.getByRole('button', { name: 'Завести шлюз' })).toBeFocused();
  });
});

test.describe('список, который заменяется целиком', () => {
  test('регион покрытия не добавить, пока список не пришёл: форма стёрла бы прежние', async ({
    page,
  }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Ответ со списком придерживается. Форма, работавшая до него, отправляла
    // `[новый регион]`, и API заменял им весь список (ui-review, 2026-09-14).
    await page.route(/\/partners\/[^/]+\/coverage$/u, async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    });

    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');
    await page
      .getByRole('row')
      .filter({ hasText: 'Иванов Иван Иванович' })
      .getByRole('button', { name: 'Открыть' })
      .click();

    await expect(page.getByText('Загружаем покрытие…')).toBeVisible();
    await expect(page.getByLabel('Добавить регион')).toHaveCount(0);
    // И не «список пуст — берёт любой регион»: до ответа это неправда.
    await expect(page.getByText('Список пуст')).toHaveCount(0);

    release();
    await expect(page.getByLabel('Добавить регион')).toBeVisible();
  });
});

test.describe('учётные записи', () => {
  test('свою запись администратор не закрывает: вернуть его смог бы только другой', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');

    const own = page.getByRole('row').filter({ hasText: PEOPLE.admin });
    await expect(own.getByText('ваша запись')).toBeVisible();
    await expect(own.getByRole('button', { name: 'Изменить' })).toHaveCount(0);

    // Обратная половина: у чужой записи выбор есть, иначе проверка прошла бы и на пустом экране.
    const other = page.getByRole('row').filter({ hasText: PEOPLE.support });
    await expect(other.getByRole('button', { name: 'Изменить' })).toBeVisible();
  });
});

test.describe('таблица шире экрана', () => {
  // Без фокуса прокручиваемый вбок блок недоступен с клавиатуры — правую часть таблицы
  // без мыши не увидеть (axe `scrollable-region-focusable`, `pnpm ui:screens` 2026-09-22).
  test.describe('телефон', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('прокручиваемая таблица берёт фокус и называет себя', async ({ page }) => {
      await signIn(page, PEOPLE.admin);
      await page.goto('/users');

      const table = page.locator('[data-slot="table-container"]').first();
      await expect(table).toHaveAttribute('tabindex', '0');
      await expect(table).toHaveAttribute('role', 'region');
      await table.focus();
      await expect(table).toBeFocused();
    });
  });

  test.describe('широкий экран', () => {
    // 1920, а не 1280: на 1280 таблица учётных записей шире места и столбец действий
    // уходит за край (замер 2026-09-22) — там фокус как раз нужен.
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('та же таблица, поместившись, лишней остановки Tab не добавляет', async ({ page }) => {
      // Обратная половина: фокус нужен только прокручиваемому блоку, иначе каждая таблица
      // стала бы лишним нажатием Tab.
      await signIn(page, PEOPLE.admin);
      await page.goto('/users');

      const table = page.locator('[data-slot="table-container"]').first();
      await expect(page.getByRole('row').filter({ hasText: PEOPLE.support })).toBeVisible();
      await expect(table).not.toHaveAttribute('tabindex', '0');
    });
  });
});

test.describe('первый запуск', () => {
  // ADR-0050. На стенде администратор заведён — живьём проверяется закрытая дверь.
  // Открытая — подменой ответов API в браузере: логику заведения проверяют тесты с базой,
  // а здесь — что кабинет ведёт человека верно.
  test('с заведённым администратором страница говорит «уже выполнен», а вход остаётся входом', async ({
    page,
  }) => {
    await page.goto('/setup');
    await expect(page.getByText('Первый запуск уже выполнен')).toBeVisible();
    await page.getByRole('link', { name: 'Ко входу' }).click();
    await expect(page).toHaveURL(/\/login$/u);
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });

  test('без администратора вход ведёт на первый запуск, и форма доводит до входа', async ({
    page,
  }) => {
    let posted = 0;
    let created = false;
    await page.route('**/api/setup', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { required: !created } });
        return;
      }
      posted += 1;
      const body = route.request().postDataJSON() as { code: string };
      if (body.code !== 'B4PR-3N3H-CCP5') {
        await route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'validation_failed',
              message: 'Код первого запуска не подходит',
              details: { problems: ['code: не подходит'] },
            },
          },
        });
        return;
      }
      created = true;
      await route.fulfill({ status: 201, json: { user: { id: 'x', role: 'admin' } } });
    });

    await page.goto('/login');
    await expect(page).toHaveURL(/\/setup$/u);

    await page.getByLabel('Код первого запуска').fill('AAAA-AAAA-AAAA');
    await page.getByLabel('Адрес почты администратора').fill('owner@example.test');
    await page.getByLabel('Имя').fill('Владелец Площадки');
    await page.getByLabel('Пароль — не короче 12 знаков').fill('достаточно длинный пароль');
    await page.getByLabel('Пароль ещё раз').fill('другой длинный пароль');
    await page.getByRole('button', { name: 'Завести администратора' }).click();
    // Несовпадение ловится до отправки: опечатка в пароле единственного администратора
    // запирает площадку.
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();
    expect(posted).toBe(0);

    await page.getByLabel('Пароль ещё раз').fill('достаточно длинный пароль');
    await page.getByRole('button', { name: 'Завести администратора' }).click();
    await expect(page.getByText('Код первого запуска не подходит')).toBeVisible();

    await page.getByLabel('Код первого запуска').fill('B4PR-3N3H-CCP5');
    await page.getByRole('button', { name: 'Завести администратора' }).click();
    await expect(page.getByText('Администратор заведён')).toBeVisible();
    await page.getByRole('link', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/login$/u);
  });
});
