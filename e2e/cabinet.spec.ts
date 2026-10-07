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
  /** Служба такси, у которой есть и свои SIM: один вход, два кабинета (ADR-0052). */
  both: 'both@e2e.zvonix.test',
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
    ['admin', /\/overview$/u],
    ['support', /\/overview$/u],
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

test.describe('один вход — два кабинета', () => {
  test('переключатель в шапке ведёт в другой кабинет, меню меняется вместе с ним', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.both);
    await expect(page).toHaveURL(/\/my\/calls$/u);

    const switcher = page.getByRole('navigation', { name: 'Кабинет' });
    await switcher.getByRole('link', { name: 'Партнёр' }).click();
    await expect(page).toHaveURL(/\/partner\/calls$/u);
    await expect(switcher.getByText('Партнёр')).toHaveAttribute('aria-current', 'page');

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByRole('link', { name: 'Моё оборудование' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Мои линии' })).toHaveCount(0);
  });

  test('у кого кабинет один, переключателя нет, а в меню — заявка на второй', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await expect(page.getByRole('navigation', { name: 'Кабинет' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Стать партнёром' }).click();
    await expect(page.getByRole('heading', { name: 'Заявка: кабинет партнёра' })).toBeVisible();
  });
});

test.describe('заявки', () => {
  test('регистрация отправляет заявку и говорит, что дальше', async ({ page }) => {
    await page.goto('/register');
    await page.getByRole('button', { name: /Партнёр/u }).click();
    await page.getByLabel('Ваше имя').fill('Орлов Максим');
    await page.getByLabel('Почта — она же логин').fill('orlov@e2e.zvonix.test');
    await page.getByLabel('Пароль').fill('очень-длинный-пароль');
    await page.getByLabel(/Согласен/u).check();
    await page.getByRole('button', { name: 'Отправить заявку' }).click();

    await expect(page.getByRole('heading', { name: 'Заявка отправлена' })).toBeVisible();
  });

  test('администратор одобряет партнёра окном с псевдонимом', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Смирнов Олег Петрович/u });
    await row.getByRole('button', { name: 'Одобрить' }).click();

    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Псевдоним для клиентов').fill('Партнёр 40');
    await dialog.getByRole('button', { name: 'Одобрить и открыть кабинет' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Смирнов Олег Петрович/u })).toHaveCount(0);
  });

  test('без подтверждённой почты одобрить нельзя, и экран говорит почему', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Кузнецова Мария/u });
    await expect(row.getByText('почта не подтверждена — одобрить пока нельзя')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Одобрить' })).toBeDisabled();
  });

  test('письмо не дошло — администратор подтверждает адрес вручную, и одобрить можно', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Кузнецова Мария/u });
    await row.getByRole('button', { name: 'Подтвердить почту' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('журнал');
    await dialog.getByRole('button', { name: 'Подтвердить адрес' }).click();

    await expect(row.getByText('почта не подтверждена — одобрить пока нельзя')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Одобрить' })).toBeEnabled();
  });
});

test.describe('кабинета ещё нет', () => {
  test('экран говорит, где заявка и что осталось сделать самому', async ({ page }) => {
    // Раньше здесь была одна фраза «кабинетов пока нет», а в меню — «Второй кабинет».
    await signIn(page, 'waiting@e2e.zvonix.test');
    await expect(
      page.getByRole('heading', { name: 'Заявка на кабинет партнёра на проверке' }),
    ).toBeVisible();
    await expect(page.getByText(/Подтвердите адрес/u)).toBeVisible();
    await page.getByRole('button', { name: 'Прислать письмо ещё раз' }).click();
    await expect(page.getByText(/Письмо отправлено ещё раз/u)).toBeVisible();

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByText('Второй кабинет')).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Моя заявка' })).toBeVisible();
    // Имя в углу меню: кабинет читал `fullName`, а API отдаёт `full_name`.
    await expect(rail.getByText('Соколов Андрей')).toBeVisible();
  });
});

test.describe('версия выпуска в углу панели', () => {
  // Стенд собран не из выпуска: файла RELEASE нет, и кабинет так и говорит, а не выдумывает.
  test('администратор её видит', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByText('сборка не из выпуска')).toBeVisible();
  });

  test('клиент — нет: номер выпуска подсказывает, какие уязвимости пробовать', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    const rail = page.getByRole('navigation', { name: 'Разделы' });
    // Панель рисуется после ответа о сессии; клиенту запрос версии не делается вовсе,
    // так что после её появления ждать больше нечего.
    await expect(rail).toBeVisible();
    await expect(rail.getByText(/сборка не из выпуска|^версия /u)).toHaveCount(0);
  });
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
    await expect(page.getByRole('button', { name: 'Добавить партнёра' })).toHaveCount(0);
    // Данные при этом на месте: раздел открыт целиком, а не наполовину.
    await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
  });

  test('администратор на том же экране действие видит', async ({ page }) => {
    // Обратная половина: если бы кнопки не было ни у кого, предыдущая проверка
    // проходила бы и на сломанном экране.
    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');

    await expect(page.getByRole('button', { name: 'Добавить партнёра' })).toBeVisible();
    await expect(page.getByText('Только чтение:')).toHaveCount(0);
  });
});

test.describe('ручное пополнение партнёра', () => {
  test('администратор пополняет партнёра из его карточки, поддержка кнопки не видит', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const page = await adminContext.newPage();
    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');
    await page
      .getByRole('link', { name: /Иванов Иван Иванович/u })
      .first()
      .click();

    await page.getByRole('button', { name: 'Пополнить' }).click();
    await page.getByLabel('Сумма, ₽').fill('250');
    await page.getByLabel('Основание').fill('Премия за месяц');
    await page.getByRole('button', { name: /Пополнить \d/u }).click();
    await expect(page.getByText(/Проведено\. Причитается:/u)).toBeVisible();

    // Выплата уменьшает причитающееся и тоже подтверждается кнопкой с суммой.
    await page.getByRole('button', { name: 'Выплатить', exact: true }).click();
    await page.getByLabel('Сумма, ₽').fill('100');
    await page.getByLabel('Основание').fill('Перевод на карту');
    await page.getByRole('button', { name: /Выплатить \d/u }).click();
    await expect(page.getByText(/Выплата записана\. Причитается:/u)).toBeVisible();

    const supportContext = await browser.newContext();
    const support = await supportContext.newPage();
    await signIn(support, PEOPLE.support);
    await support.goto(page.url());
    await expect(support.getByText('Только чтение:')).toBeVisible();
    await expect(support.getByRole('button', { name: 'Пополнить' })).toHaveCount(0);
    await expect(support.getByRole('button', { name: 'Выплатить' })).toHaveCount(0);
    await expect(support.getByRole('button', { name: 'Списать' })).toHaveCount(0);

    await adminContext.close();
    await supportContext.close();
  });
});

test.describe('выплата партнёрам списком', () => {
  test('причитающееся видно списком, выплата записывается одним действием', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    const found = await page.request.get('/api/partners?name=Иванов', {
      headers: { 'X-Zvonix-Web': '1' },
    });
    const listed = (await found.json()) as { partners: { id: string }[] };
    const partnerId = listed.partners[0]?.id ?? '';
    const credited = await page.request.post(`/api/partners/${partnerId}/deposit`, {
      headers: { 'X-Zvonix-Web': '1' },
      data: {
        amount: '400',
        idempotencyKey: `e2e-payout-in-${String(Date.now())}`,
        description: 'Начислено',
      },
    });
    expect(credited.ok()).toBe(true);

    await page.goto('/payouts');
    await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
    await page.getByRole('button', { name: /Записать выплаты/u }).click();
    await page.getByRole('button', { name: /Записать на/u }).click();
    await expect(page.getByText(/выплата записана, причитается/u)).toBeVisible();
  });
});

test.describe('сообщения MAX (ADR-0071)', () => {
  test('партнёр заводит аккаунт, видит QR-код, задаёт цену; администратор видит его у себя', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    const enabled = await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });
    expect(enabled.ok()).toBe(true);

    const partnerContext = await browser.newContext();
    const partner = await partnerContext.newPage();
    await signIn(partner, PEOPLE.partner);
    await partner.goto('/partner/messages');
    await partner.getByRole('button', { name: 'Добавить аккаунт' }).click();
    await partner.getByLabel('Название').fill('Основной');
    await partner.getByRole('button', { name: 'Добавить', exact: true }).click();

    // После заведения сразу открывается вход по QR-коду.
    await expect(partner.getByRole('dialog', { name: /Вход в MAX/u })).toBeVisible();
    await expect(partner.getByAltText('QR-код для входа в MAX')).toBeVisible();
    await partner.keyboard.press('Escape');

    const row = partner.getByRole('row', { name: /Основной/u });
    await expect(row.getByText('Ждёт входа')).toBeVisible();
    // Цена — в тарифе (ADR-0075): без тарифа аккаунту предлагают его создать.
    await expect(row.getByRole('link', { name: 'Создайте тариф' })).toBeVisible();
    await partner.goto('/partner/prices?tab=max');
    await partner.getByRole('button', { name: 'Создать тариф' }).click();
    await partner.getByLabel('Название').fill('Основной');
    await partner.getByLabel('Цена за сообщение, ₽').fill('0,45');
    await partner.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(
      partner.getByRole('row', { name: /Основной/u }).getByText('по умолчанию'),
    ).toBeVisible();

    // Новый тариф — умолчание: аккаунт сразу получает его цену; свой тариф назначается выбором в строке.
    await partner.goto('/partner/messages');
    const accountRow = partner.getByRole('row', { name: /Основной/u });
    await expect(accountRow.getByText(/0,45/u)).toBeVisible();
    await expect(accountRow.getByLabel(/Тариф аккаунта/u)).toHaveValue('');

    await admin.goto('/messaging');
    await expect(admin.getByRole('row', { name: /Основной/u })).toBeVisible();
    // Названия провайдера нет ни в кабинете партнёра, ни в кабинете администратора.
    await expect(partner.getByText(/green/iu)).toHaveCount(0);
    await expect(admin.getByText(/green/iu)).toHaveCount(0);

    await adminContext.close();
    await partnerContext.close();
  });
});

test.describe('проверка ключа провайдера сообщений', () => {
  test('кнопка «Проверить ключ» в настройках отвечает по-русски и без имени провайдера', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/settings?section=messaging');
    await page.getByRole('button', { name: 'Проверить ключ' }).click();
    await expect(page.getByText(/Ключ принят/u)).toBeVisible();
  });
});

test.describe('настройки площадки по разделам', () => {
  test('раздел выбирается слева и хранится в адресе; несохранённое помечено и не теряется при переходе', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
    await expect(page.getByRole('heading', { name: 'Почта' })).toBeVisible();
    // Другой раздел на экран не выводится: страница не растёт с каждой новой настройкой.
    await expect(page.getByRole('heading', { name: 'Хранение' })).toHaveCount(0);

    await page.getByLabel('Узел SMTP').fill('smtp.example.test');
    await nav.getByRole('button', { name: 'Хранение' }).click();
    await expect(page).toHaveURL(/section=retention/u);
    await expect(page.getByRole('heading', { name: 'Хранение' })).toBeVisible();
    await expect(nav.getByRole('img', { name: 'несохранённых: 1' })).toBeVisible();

    await nav.getByRole('button', { name: 'Почта' }).click();
    await expect(page.getByLabel('Узел SMTP')).toHaveValue('smtp.example.test');
  });
});

test.describe('наценка на сообщения MAX (ADR-0073)', () => {
  test('те же правила, что у звонков: доля и фикс за сообщение; в настройках площадки наценки нет', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/tariffs');
    await expect(page.getByRole('heading', { name: 'Наценка на звонки' })).toBeVisible();
    // Наценка на сообщения — на своей вкладке.
    await page.getByRole('tab', { name: 'Сообщения MAX' }).click();
    await expect(page).toHaveURL(/tab=max/u);
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Наценка на сообщения MAX' }) });
    // Общее правило заведено миграцией: 20 %.
    await expect(section.getByText('20 %')).toBeVisible();

    await section.getByRole('button', { name: 'Добавить правило' }).click();
    await page.getByLabel('Доля, %').fill('250');
    await page.getByLabel('Фикс за сообщение, ₽').fill('0,05');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('за сообщение');
    await dialog.getByRole('button', { name: 'Добавить правило' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(section.getByText('250 %')).toBeVisible();
    await expect(section.getByText(/0,05/u)).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByText('Наценка на сообщение, %')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Сообщения: цена' })).toHaveCount(0);
  });
});

test.describe('сообщения MAX у клиента (ADR-0071)', () => {
  test('клиент видит форму и журнал; без рабочего аккаунта сказано, что отправлять некуда', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    const enabled = await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });
    expect(enabled.ok()).toBe(true);

    const clientContext = await browser.newContext();
    const page = await clientContext.newPage();
    await signIn(page, PEOPLE.client);
    await page.goto('/my/messages');

    await expect(page.getByText(/нет доступных аккаунтов/u)).toBeVisible();
    await expect(page.getByLabel('Номер получателя')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await expect(page.getByText('Сообщений пока нет.')).toBeVisible();
    // Провайдер нигде не назван.
    await expect(page.getByText(/green/iu)).toHaveCount(0);

    await adminContext.close();
    await clientContext.close();
  });
});

test.describe('отправка сообщений из кабинета партнёра', () => {
  test('без клиентского кабинета — путь к заявке, с ним — форма отправки со ссылкой на счёт', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });

    const partnerContext = await browser.newContext();
    const partner = await partnerContext.newPage();
    await signIn(partner, PEOPLE.partner);
    await partner.goto('/partner/send');
    await expect(partner.getByText(/Клиентского кабинета у вас пока нет/u)).toBeVisible();
    await expect(partner.getByRole('link', { name: 'Стать клиентом' }).first()).toBeVisible();
    // Формы, которая отказала бы, нет.
    await expect(partner.getByLabel('Номер получателя')).toHaveCount(0);

    const bothContext = await browser.newContext();
    const both = await bothContext.newPage();
    await signIn(both, PEOPLE.both);
    await both.goto('/partner/send');
    await expect(
      both.getByText(/Деньги списываются со счёта вашего клиентского кабинета/u),
    ).toBeVisible();
    await expect(both.getByLabel('Номер получателя')).toBeVisible();
    await expect(both.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();

    await adminContext.close();
    await partnerContext.close();
    await bothContext.close();
  });
});

test.describe('подключение по SMPP (ADR-0072)', () => {
  test('клиент создаёт подключение, видит пароль один раз, выпускает новый и отключает', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    const enabled = await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });
    expect(enabled.ok()).toBe(true);

    const clientContext = await browser.newContext();
    const page = await clientContext.newPage();
    await signIn(page, PEOPLE.client);
    await page.goto('/my/messages');

    await page.getByRole('button', { name: 'Создать подключение' }).click();
    const secret = page.getByRole('region', { name: 'Пароль SMPP' });
    await expect(secret).toBeVisible();
    await expect(secret.getByText(/^zx[a-z0-9]{8}$/u)).toBeVisible();
    await secret.getByRole('button', { name: 'Записал, закрыть' }).click();
    await expect(secret).toHaveCount(0);

    // Пароль после закрытия нигде не показывается; имя и сервер остаются.
    await expect(page.getByText('Был на связи')).toBeVisible();

    await page.getByLabel(/Разрешённые адреса/u).fill('203.0.113.5');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByLabel(/Разрешённые адреса/u)).toHaveValue('203.0.113.5');

    await page.getByRole('button', { name: 'Новый пароль' }).click();
    await page.getByRole('button', { name: 'Выпустить' }).click();
    await expect(page.getByRole('region', { name: 'Пароль SMPP' })).toBeVisible();

    await page.getByRole('button', { name: 'Отключить', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Отключить' }).click();
    await expect(page.getByText('Отключено')).toBeVisible();

    // Провайдер нигде не назван.
    await expect(page.getByText(/green/iu)).toHaveCount(0);

    await adminContext.close();
    await clientContext.close();
  });
});

test.describe('обзор для сотрудников', () => {
  test('администратор после входа попадает в «Обзор»: дела, показатели, графики; числа ведут дальше', async ({
    page,
  }) => {
    // Страница не должна ходить в API с неверными запросами: пустые графики из-за отказа 400 прошли бы
    // незамеченными (так и было: «Обзор» просил 14 суток, а сводка принимает 1, 7, 30 и 90).
    const refused: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 400) {
        refused.push(`${String(response.status())} ${response.url()}`);
      }
    });
    await signIn(page, PEOPLE.admin);
    await page.goto('/');
    await expect(page).toHaveURL(/\/overview$/u);
    await expect(page.getByRole('heading', { name: 'Вызовы по дням' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Требует внимания' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Доля состоявшихся/u })).toBeVisible();

    // Четырнадцать столбцов за четырнадцать суток: график получил данные, а не пустой ответ.
    await expect(page.locator('[role="img"][aria-label="Вызовы по дням"] > div')).toHaveCount(14);
    await page.waitForLoadState('networkidle');
    expect(refused).toEqual([]);

    await page.getByRole('link', { name: /Заявки на рассмотрении/u }).click();
    await expect(page).toHaveURL(/\/applications/u);
  });
});

test.describe('серверы в «Обзоре»', () => {
  test('у каждого сервера процессор, память и диск полосками; перегрузка подсвечена по порогам', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    // Ответ подменён: на стенде замеров нет, а проверяется вид блока.
    await page.route('**/api/servers*', (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              scope: 'platform',
              id: null,
              name: 'Площадка',
              status: null,
              stale: false,
              current: {
                load1: 0.8,
                cpu_cores: 4,
                mem_total_mb: 8192,
                mem_available_mb: 2048,
                disk_total_mb: 100000,
                disk_free_mb: 5000,
                active_calls: null,
                taken_at: new Date().toISOString(),
              },
              series: [],
            },
            {
              scope: 'node',
              id: 'n1',
              name: 'Узел Москва',
              status: 'online',
              stale: true,
              current: {
                load1: 4,
                cpu_cores: 2,
                mem_total_mb: 4096,
                mem_available_mb: 3500,
                disk_total_mb: 50000,
                disk_free_mb: 40000,
                active_calls: 7,
                taken_at: new Date().toISOString(),
              },
              series: [],
            },
          ],
        },
      }),
    );
    await page.goto('/overview');
    const block = page.getByRole('region', { name: 'Серверы' });
    await expect(block).toBeVisible();
    await expect(block.getByText('Площадка')).toBeVisible();
    await expect(block.getByText('звонков 7')).toBeVisible();
    await expect(block.getByText('замер давний')).toBeVisible();

    // Диск площадки занят на 95 %, память — на 75 %, процессор — на 20 %.
    const first = block.getByRole('link', { name: /Площадка/u });
    await expect(first.getByRole('meter', { name: 'Диск' })).toHaveAttribute('aria-valuenow', '95');
    await expect(first.getByRole('meter', { name: 'Память' })).toHaveAttribute(
      'aria-valuenow',
      '75',
    );
    await expect(first.getByRole('meter', { name: 'Процессор' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    );
  });
});

test.describe('сообщения в «Обзоре»', () => {
  test('блок появляется, когда сообщения были: показатели за 7 суток и график; без них блока нет', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/overview');
    await expect(page.getByRole('heading', { name: 'Вызовы по дням' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Сообщения MAX' })).toHaveCount(0);

    // Ответ подменён: на стенде сообщений нет, а проверяется поведение блока.
    const series = Array.from({ length: 14 }, (_unused, index) => ({
      day: `2026-10-${String(index + 1).padStart(2, '0')}`,
      messages: index >= 7 ? 10 : 5,
      delivered: index >= 7 ? 8 : 5,
      failed: index >= 7 ? 2 : 0,
      revenue: index >= 7 ? '5.4' : '2.7',
      margin: index >= 7 ? '0.9' : '0.45',
    }));
    await page.route('**/api/messages/overview*', (route) =>
      route.fulfill({ json: { days: 14, series } }),
    );
    await page.reload();
    const block = page.getByRole('region', { name: 'Сообщения MAX' });
    await expect(block).toBeVisible();
    await expect(block.getByRole('link', { name: /Сообщений/u })).toContainText('70');
    await expect(block.getByRole('link', { name: /Не отправлено/u })).toContainText('14');
    await expect(block.getByRole('img', { name: 'Сообщения по дням' })).toBeVisible();
  });
});

test.describe('вид таблиц: колонки и наборы фильтров', () => {
  test('колонку можно скрыть, выбор переживает перезагрузку; последняя видимая остаётся', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/clients');
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Остаток' })).toBeVisible();

    await page.getByRole('button', { name: /Колонки/u }).click();
    const panel = page.getByRole('dialog', { name: 'Какие колонки показывать' });
    await panel.getByLabel('Остаток').uncheck();
    await expect(table.getByRole('columnheader', { name: 'Остаток' })).toBeHidden();
    // Ячейки той же колонки скрыты вместе с шапкой: «1 500,5 ₽» из таблицы пропало.
    await expect(table.getByRole('cell', { name: /1\s500,5/u })).toBeHidden();
    await expect(table.getByRole('columnheader', { name: 'Название' })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.reload();
    await expect(table.getByRole('columnheader', { name: 'Остаток' })).toBeHidden();

    await page.getByRole('button', { name: /Колонки/u }).click();
    await page.getByRole('button', { name: 'Показать все' }).click();
    await expect(table.getByRole('columnheader', { name: 'Остаток' })).toBeVisible();
  });

  test('набор фильтров сохраняется, применяется из пустого вида и удаляется', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/clients?name=%D0%B1%D1%80%D0%B8%D0%B7');
    await expect(page.getByRole('cell', { name: 'Такси «Бриз»', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Такси «Волна»', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /Наборы/u }).click();
    const panel = page.getByRole('dialog', { name: 'Сохранённые наборы фильтров' });
    await panel.getByLabel('Название набора').fill('Только «Бриз»');
    await panel.getByRole('button', { name: 'Сохранить текущие' }).click();
    await expect(panel.getByRole('button', { name: 'Только «Бриз»', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Escape');

    // Из чистой страницы набор возвращает фильтры в адрес.
    await page.goto('/clients');
    await expect(page.getByRole('cell', { name: 'Такси «Волна»', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Наборы/u }).click();
    await page.getByRole('button', { name: 'Только «Бриз»', exact: true }).click();
    await expect(page).toHaveURL(/name=/u);
    await expect(page.getByRole('cell', { name: 'Такси «Волна»', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /Наборы/u }).click();
    await page.getByRole('button', { name: 'Удалить набор «Только «Бриз»»' }).click();
    await expect(page.getByText('Сохранённых наборов нет.')).toBeVisible();
  });
});

test.describe('меню и поиск по разделам', () => {
  test('Ctrl+K открывает поиск, по запросу находит раздел и переходит в него', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');
    // Страница должна ожить: обработчик клавиши вешается после загрузки кабинета.
    await expect(page.getByRole('button', { name: 'Поиск по разделам' })).toBeVisible();
    // Горячая клавиша слушается и на русской раскладке: она привязана к коду клавиши.
    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog', { name: 'Поиск по разделам' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill('настрой пло');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings$/u);

    // Недавние: после перехода прежний раздел предлагается без ввода.
    await page.keyboard.press('Control+KeyK');
    await expect(page.getByRole('option', { name: /Учётные записи/u })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('поиск находит клиента по названию без учёта регистра и открывает его карточку', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');
    await expect(page.getByRole('button', { name: 'Поиск по разделам' })).toBeVisible();
    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog', { name: 'Поиск по разделам' });
    await dialog.getByRole('combobox').fill('бриз');
    const option = dialog.getByRole('option', { name: /Бриз/u });
    await expect(option).toBeVisible();
    await expect(option).toContainText('Клиент');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/u);
  });

  test('плотность таблиц: строки ниже, выбор запоминается', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/clients');
    const cell = page.getByRole('cell', { name: /Бриз/u }).first();
    await expect(cell).toBeVisible();
    const normal = (await cell.boundingBox())?.height ?? 0;

    const switcher = page.getByRole('button', { name: 'Плотные таблицы' });
    await switcher.click();
    await expect(switcher).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    expect((await cell.boundingBox())?.height ?? normal).toBeLessThan(normal);

    // До первой отрисовки: после перезагрузки плотность уже стоит, таблица не дёргается.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await page.getByRole('button', { name: 'Плотные таблицы' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-density', 'compact');
  });

  test('группа меню сворачивается, запоминается и разворачивается вновь', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');
    const group = page.getByRole('button', { name: 'Деньги', exact: true });
    const link = page.getByRole('link', { name: 'Платежи', exact: true });
    await expect(link).toBeVisible();

    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(link).toBeHidden();

    await page.reload();
    await expect(link).toBeHidden();

    await page.getByRole('button', { name: 'Деньги', exact: true }).click();
    await expect(link).toBeVisible();
  });
});

// После сценария клиента: он создаёт подключение, и тому нужен чистый кабинет клиента.
test.describe('SMPP у сотрудников', () => {
  test('администратор видит подключение клиента и отключает его через подтверждение', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });

    const clientContext = await browser.newContext();
    const client = await clientContext.newPage();
    await signIn(client, PEOPLE.client);
    const created = await client.request.post('/api/client/messages/smpp', {
      headers: { 'X-Zvonix-Web': '1' },
    });
    // Подключение могло быть создано другим сценарием: для проверки важно, что оно есть.
    expect([201, 409]).toContain(created.status());

    await admin.goto('/messaging');
    const block = admin.getByRole('region', { name: 'Подключения по SMPP' });
    await expect(block).toBeVisible();
    await expect(block.getByText(/^zx[a-z0-9]{8}$/u).first()).toBeVisible();

    // Сценарий клиента выше оставил своё подключение отключённым: сначала возвращаем его.
    const enable = block.getByRole('button', { name: 'Включить' }).first();
    if ((await enable.count()) > 0) {
      await enable.click();
      await expect(block.getByRole('button', { name: 'Отключить' }).first()).toBeVisible();
    }

    await block.getByRole('button', { name: 'Отключить' }).first().click();
    await admin.getByRole('alertdialog').getByRole('button', { name: 'Отключить' }).click();
    await expect(block.getByText('Отключено').first()).toBeVisible();
    await block.getByRole('button', { name: 'Включить' }).first().click();
    await expect(block.getByText('Включено').first()).toBeVisible();

    await adminContext.close();
    await clientContext.close();
  });
});

test.describe('вкладки «Звонки» и «Сообщения MAX» у партнёра', () => {
  test('цены и лимиты сообщений — вкладкой на тех же страницах, что и звонки', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, PEOPLE.admin);
    await admin.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'messaging.enabled': true } },
    });
    await adminContext.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, PEOPLE.partner);

    await page.goto('/partner/limits');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: 'Звонки' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await tabs.getByRole('tab', { name: 'Сообщения MAX' }).click();
    await expect(page).toHaveURL(/tab=max/u);
    await expect(page.getByRole('columnheader', { name: 'В минуту' })).toBeVisible();

    // Ссылка открывает нужную вкладку сразу.
    await page.goto('/partner/prices?tab=max');
    await expect(page.getByRole('columnheader', { name: 'Цена за сообщение' })).toBeVisible();
    await tabs.getByRole('tab', { name: 'Звонки' }).click();
    await expect(page).not.toHaveURL(/tab=/u);
    await context.close();
  });
});

test.describe('обновление из кабинета (ADR-0074)', () => {
  test('администратор видит выпуски и журнал, ставит заявку и отменяет её', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/updates');

    await expect(page.getByRole('heading', { name: 'Выпуски' })).toBeVisible();
    await expect(page.getByRole('main').getByText('сборка не из выпуска')).toBeVisible();
    const releases = page.getByRole('region', { name: 'Выпуски' });
    await expect(releases.getByText('v9.9.9')).toBeVisible();

    // Последнее завершённое обновление показано с шагами и журналом.
    const progress = page.getByRole('region', { name: 'Ход обновления' });
    await expect(progress.getByRole('listitem').filter({ hasText: 'Копия базы' })).toBeVisible();
    await expect(progress.getByLabel('Журнал выкладки')).toContainText('DEPLOY_OK v9.9.8');

    await releases.getByRole('button', { name: 'Обновить' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Обновить' }).click();

    const queue = page.getByRole('region', { name: 'Очередь' });
    await expect(queue.getByText('Ждёт службу')).toBeVisible();
    // Пока заявка ждёт, ни вторую выкладку, ни проверку обновлений начать нельзя.
    await expect(page.getByRole('button', { name: 'Идёт работа…' })).toBeDisabled();
    await expect(releases.getByRole('button', { name: 'Обновить' }).first()).toBeDisabled();

    await queue.getByRole('button', { name: 'Отменить' }).click();
    await expect(queue).toBeHidden();
    await expect(releases.getByRole('button', { name: 'Обновить' }).first()).toBeEnabled();
  });

  test('поддержке раздел закрыт', async ({ page }) => {
    await signIn(page, PEOPLE.support);
    const response = await page.request.get('/api/updates');
    expect(response.status()).toBe(403);
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'Обновления' })).toHaveCount(0);
  });
});

test.describe('шрифты со своего адреса', () => {
  test('IBM Plex загружается с площадки, а не с чужого сервера', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (request) => {
      const host = new URL(request.url()).host;
      if (host.includes('googleapis') || host.includes('gstatic')) foreign.push(request.url());
    });
    await page.goto('/login');
    const loaded = await page.evaluate(async () => {
      await document.fonts.load('16px "IBM Plex Sans"', 'Привет');
      return document.fonts.check('16px "IBM Plex Sans"', 'Привет');
    });
    expect(loaded).toBe(true);
    expect(foreign).toEqual([]);
  });
});

test.describe('прослушивание записи', () => {
  test('«Прослушать» открывает окно с плеером, закрытие его убирает', async ({ page }) => {
    const callId = '01a00000-0000-7000-8000-000000000001';
    await signIn(page, PEOPLE.client);
    // Ответы подменены: на стенде нет ни вызовов, ни записей, а проверяется поведение окна.
    await page.route('**/api/client/calls*', (route) =>
      route.fulfill({
        json: {
          total: 1,
          calls: [
            {
              id: callId,
              destination: '79230189196',
              status: 'completed',
              failure_reason: null,
              duration_seconds: 32,
              cost: '0.709',
              started_at: new Date().toISOString(),
              answered_at: null,
              ended_at: null,
              region: null,
              channel: { id: 'c1', name: 'тест' },
              operator: null,
            },
          ],
        },
      }),
    );
    await page.route('**/api/recordings/available*', (route) =>
      route.fulfill({ json: { recordings: [{ call_id: callId, recording_id: 'r1' }] } }),
    );
    await page.route('**/api/recordings/r1/link', (route) =>
      route.fulfill({
        json: {
          url: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
        },
      }),
    );

    await page.goto('/my/calls');
    await page.getByRole('button', { name: 'Прослушать' }).click();

    const dialog = page.getByRole('dialog', { name: 'Запись разговора' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/79230189196/u)).toBeVisible();
    await expect(dialog.locator('audio')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('акт и выписка за месяц (ADR-0069)', () => {
  test('клиент видит акт, при печати меню скрыто, а лист остаётся', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/act');

    await expect(page.getByRole('heading', { name: /Акт об оказанных услугах за/u })).toBeVisible();
    await expect(page.getByText('Движение по счёту')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Печать / PDF' })).toBeEnabled();

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Печать / PDF' })).toBeHidden();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Акт об оказанных услугах за/u })).toBeVisible();
  });

  test('партнёр видит выписку: остаток на начало месяца и итог', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/statement');

    await expect(page.getByRole('heading', { name: /Выписка по начислениям за/u })).toBeVisible();
    await expect(page.getByText('Причитается на начало месяца')).toBeVisible();
    await expect(page.getByText('За этот месяц вызовов не было.')).toBeVisible();
  });
});

test.describe('второй фактор (ADR-0067)', () => {
  test('страница «Безопасность» показывает ключ для приложения и просит код', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/security');

    await expect(page.getByRole('heading', { name: 'Второй фактор не подключён' })).toBeVisible();
    await page.getByRole('button', { name: 'Подключить' }).click();
    await expect(page.getByTestId('totp-secret')).toBeVisible();
    // Подтверждение не нажимаем: фактор у общей учётной записи стенда сломал бы вход другим сценариям.
    await expect(page.getByRole('button', { name: 'Подтвердить и включить' })).toBeDisabled();
  });
});

test.describe('серверы (ADR-0065)', () => {
  test('администратор и поддержка видят нагрузку площадки и меняют период', async ({ browser }) => {
    for (const person of [PEOPLE.admin, PEOPLE.support]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, person);
      await page.goto('/servers');

      await expect(page.getByRole('heading', { name: 'Площадка' })).toBeVisible();
      await expect(page.getByRole('meter', { name: 'Процессор' })).toBeVisible();
      await expect(page.getByRole('img', { name: /нагрузка процессора/u })).toBeVisible();

      await page.getByRole('button', { name: 'Неделя' }).click();
      await expect(page.getByRole('button', { name: 'Неделя' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await context.close();
    }
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

    // Заголовок, а не любой текст: то же имя стоит в углу меню, как только загрузится сессия.
    await expect(page.getByRole('heading', { name: 'Иванов Иван Иванович' })).toBeVisible();
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

  // Регрессия 2026-09-30: «Вызовы» клали в кэш список линий, «Мои линии» ждали в том же
  // ключе объект, и переход по меню ронял страницу. Прямой заход этого не показывал.
  test('линии открываются переходом из меню после вызовов', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await expect(page).toHaveURL(/\/my\/calls$/u);
    await expect(page.getByLabel('Линия')).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Разделы' })
      .getByRole('link', { name: 'Мои линии' })
      .click();
    await expect(page).toHaveURL(/\/my\/channels$/u);
    await expect(page.getByText('Диспетчерская')).toBeVisible();
  });

  test('клиент сам получает линию: пароль показан один раз, в списке его нет', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/channels');

    await page.getByRole('button', { name: 'Получить линию' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Получить линию' }).click();

    await expect(page.getByText(/Пароль показывается/u)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: /Линия \d/u })).toBeVisible();
  });

  test('обновление вызовов включается и помнится после перезагрузки', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/calls');

    const live = page.getByLabel('Обновлять');
    await expect(live).toHaveValue('0');
    await live.selectOption('5');
    await page.reload();
    await expect(page.getByLabel('Обновлять')).toHaveValue('5');
    await page.getByLabel('Обновлять').selectOption('0');
  });

  test('вызовы клиента скачиваются файлом CSV', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/calls');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Скачать таблицу' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^вызовы-\d{4}-\d{2}-\d{2}\.csv$/u);
  });

  test('остаток счёта виден в шапке на любой странице кабинета', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await expect(page.getByRole('link', { name: /Можно потратить/u })).toBeVisible();
  });
});

test.describe('пополнение счёта (ADR-0064)', () => {
  test('клиент подаёт заявку, администратор подтверждает, деньги видны клиенту', async ({
    browser,
  }) => {
    // Реквизиты задаёт администратор: без них заявки не принимаются.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, PEOPLE.admin);
    const saved = await adminPage.request.put('/api/settings', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { settings: { 'payments.manual_instructions': 'Карта 1111 2222, Иванов И. И.' } },
    });
    expect(saved.ok()).toBe(true);

    const clientContext = await browser.newContext();
    const clientPage = await clientContext.newPage();
    await signIn(clientPage, PEOPLE.client);
    await clientPage.goto('/my/money');
    await clientPage.getByRole('button', { name: 'Пополнить' }).click();
    await clientPage.getByLabel('Сумма, ₽').fill('500');
    await clientPage.getByRole('button', { name: /Создать заявку на/u }).click();
    // Реквизиты и номер заявки показаны сразу: переводить нужно по ним.
    await expect(clientPage.getByText('Карта 1111 2222')).toBeVisible();
    await expect(clientPage.getByText('Ждёт подтверждения')).toBeVisible();

    await adminPage.goto('/payments');
    await adminPage.getByRole('button', { name: 'Подтвердить' }).first().click();
    await adminPage.getByRole('button', { name: /Зачислить/u }).click();
    await expect(adminPage.getByText('Заявок, ждущих решения, нет.')).toBeVisible();

    await clientPage.reload();
    await expect(clientPage.getByText('Зачислено').first()).toBeVisible();

    await adminContext.close();
    await clientContext.close();
  });

  test('поддержка заявку видит, но решать не может', async ({ browser }) => {
    // Заявка, ждущая решения, должна быть: иначе отсутствие кнопок ничего не доказывает.
    const clientContext = await browser.newContext();
    const clientPage = await clientContext.newPage();
    await signIn(clientPage, PEOPLE.client);
    const created = await clientPage.request.post('/api/client/payments', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { amount: '200', comment: 'проверка поддержки' },
    });
    expect(created.ok()).toBe(true);

    const supportContext = await browser.newContext();
    const page = await supportContext.newPage();
    await signIn(page, PEOPLE.support);
    await page.goto('/payments');
    await expect(page.getByText('проверка поддержки')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подтвердить' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Отклонить' })).toHaveCount(0);

    await clientContext.close();
    await supportContext.close();
  });
});

test.describe('ввод денег', () => {
  // Меняет состояние стенда — поэтому после проверок, которые только читают.
  test('копейки набираются запятой — той же, с какой кабинет их показывает', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/tariffs');

    await page.getByRole('button', { name: 'Добавить правило' }).first().click();
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
    await page.getByRole('button', { name: 'Создать ключ' }).click();
    await page.getByLabel('Назначение').fill('Диспетчерская на проверке');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Создать и показать секрет' })
      .click();

    await expect(page.getByText('Ключ «Диспетчерская на проверке»')).toBeVisible();
    await expect(page.getByText(/zvx_client_/u).first()).toBeVisible();
  });

  test('отзыв спрашивает и отменяется: ключ после него не оживить', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    await page.getByRole('button', { name: 'Создать ключ' }).click();
    await page.getByLabel('Назначение').fill('Ключ на отзыв');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Создать и показать секрет' })
      .click();
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

/** Подтвердить действие в окне, которое называет последствие, — кнопкой с тем же именем. */
async function confirmAction(page: Page, action: string): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('партнёр добавляет своё оборудование', () => {
  test('шлюз добавляется с портами, настройки подключения видны на его странице', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP на проверке');
    await page.getByLabel('Слотов под SIM').fill('4');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();

    // Пароли линий показываются один раз, а шлюз встаёт строкой в общую таблицу.
    await expect(page.getByText('Входы линий шлюза «GOIP на проверке»')).toBeVisible();
    await expect(page.getByRole('region', { name: 'GOIP на проверке', exact: true })).toContainText(
      'карт 0 из 4',
    );

    await page.getByRole('link', { name: /Открыть шлюз/u }).click();
    await expect(
      page.getByRole('heading', { name: 'GOIP на проверке', exact: true }),
    ).toBeVisible();

    // Сервер, порт и режим видны всегда: раньше — только в минуту добавления.
    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('5060');
    await expect(connection).toContainText('Config by Line');

    // Указали четыре слота — четыре порта, а не «портов не заведено».
    const ports = page.getByRole('region', { name: 'Порты' });
    await expect(ports.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(4);
  });

  test('SIM вставляется в порт по номеру, оператора не спрашивают', async ({ page }) => {
    const denied: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403) denied.push(response.url());
    });

    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз под карту');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз под карту' }).click();

    await page.getByRole('button', { name: 'Вставить SIM' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Оператор')).toHaveCount(0);
    await dialog.getByLabel('Номер карты').fill('+7 913 555-00-17');
    await dialog.getByRole('button', { name: 'Вставить' }).click();

    // Источника оператора на стенде нет: площадка честно говорит, что определить
    // не смогла, а не заводит карту с выдуманным оператором.
    await expect(dialog.getByText('Не удалось определить оператора номера')).toBeVisible();
    expect(denied).toEqual([]);
  });

  test('шлюз включается одной прямой кнопкой и так же возвращается после выключения', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на выключение');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз на выключение' }).click();

    // Невключённый шлюз не пускают даже с верными настройками — и страница говорит это прямо.
    // Раньше включение пряталось в окне за кнопкой «Состояние» (владелец, 2026-09-25).
    await expect(page.getByText('Не включён', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Шлюз не включён — линии не могут подключиться/u)).toBeVisible();
    await page.getByRole('button', { name: 'Включить шлюз' }).click();
    await expect(page.getByText('Работает', { exact: true })).toBeVisible();

    // До ADR-0047 выключение партнёра не отличалось от отключения площадкой,
    // и за одной кнопкой «Включить» приходилось идти к администратору.
    await confirmAction(page, 'Выключить шлюз');
    await expect(page.getByText('Выключен вами')).toBeVisible();
    await page.getByRole('button', { name: 'Включить шлюз' }).click();
    await expect(page.getByText('Работает', { exact: true })).toBeVisible();
  });

  test('удаление называет последствие до нажатия и уводит шлюз из списка', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на удаление');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз на удаление' }).click();

    await page.getByRole('button', { name: 'Удалить шлюз' }).click();
    const dialog = page.getByRole('alertdialog');
    // Окно называет последствие, а не «вы уверены?»: удаление стоит рядом с «выключить»,
    // которое отменяется одним нажатием, и разница должна быть видна до нажатия.
    await expect(dialog).toContainText('навсегда');
    await dialog.getByRole('button', { name: 'Удалить навсегда' }).click();

    await expect(page.getByText(/Такого шлюза нет/u)).toBeVisible();
    await page.getByRole('link', { name: '← Всё оборудование' }).click();
    await expect(page.getByRole('row', { name: /Шлюз на удаление/u })).toHaveCount(0);
  });
});

test.describe('операторы связи (ADR-0053)', () => {
  test('администратор подтверждает оператора номера вручную, и номер становится рабочим', async ({
    page,
  }) => {
    // Служба проверки перенесённых номеров с сервера недоступна, а без подтверждения
    // по номеру не звонят вовсе. Человек, проверивший номер, — подтверждение.
    await signIn(page, PEOPLE.admin);
    await page.goto('/operators');

    await page.getByLabel('Номер', { exact: true }).fill('+7 913 555-44-33');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(
      page.getByText('Оператор не подтверждён — по этому номеру не звонят.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Подтвердить оператора вручную' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('журнал');
    await dialog.getByLabel('Оператор').selectOption({ label: 'МегаФон' });
    await dialog.getByRole('button', { name: 'Подтвердить оператора' }).click();

    await expect(page.getByText('Оператор подтверждён — по номеру звонят.')).toBeVisible();
    await expect(page.getByText('подтверждён администратором')).toBeVisible();
  });

  test('поддержка видит справочник и проверку номера, но не подтверждает', async ({ page }) => {
    await signIn(page, PEOPLE.support);
    await page.goto('/operators');

    await expect(page.getByText('Только чтение:')).toBeVisible();
    await page.getByLabel('Номер', { exact: true }).fill('+7 913 555-44-34');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText(/Оператор не подтверждён/u)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подтвердить оператора вручную' })).toHaveCount(
      0,
    );
  });

  test('партнёр видит префикс каждой линии и что ввести в GOIP', async ({ page }) => {
    // Без префикса GOIP сам выбирал линию, и вызов на МТС мог уйти с SIM T2.
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP с префиксами');
    await page.getByLabel('Подключение').selectOption({ label: 'Весь шлюз одним входом' });
    await page.getByLabel('Слотов под SIM').fill('2');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'GOIP с префиксами' }).click();

    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('Single Server Mode');
    await expect(connection).toContainText('Match Callee');
    const ports = page.getByRole('region', { name: 'Порты' });
    await expect(ports.getByRole('row', { name: /^1 префикс 99001/u })).toBeVisible();
    await expect(ports.getByRole('row', { name: /^2 префикс 99002/u })).toBeVisible();
  });
});

test.describe('оборудование одной таблицей, вход по линиям (ADR-0054)', () => {
  test('карты всех шлюзов видны в общей таблице, шлюз сворачивается', async ({ page }) => {
    // Раньше карты были только на странице каждого шлюза, и найти, где стоит номер,
    // можно было, лишь заходя во все по очереди (владелец, 2026-09-25).
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP в общей таблице');
    await page.getByLabel('Слотов под SIM').fill('3');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('button', { name: 'Записал, закрыть' }).click();

    const group = page.getByRole('region', { name: 'GOIP в общей таблице', exact: true });
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(3);

    await group
      .getByRole('button', { name: 'Свернуть порты шлюза «GOIP в общей таблице»' })
      .click();
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(0);
    await group
      .getByRole('button', { name: 'Раскрыть порты шлюза «GOIP в общей таблице»' })
      .click();
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(3);
  });

  test('у каждой линии свой логин, пароли показывают один раз; можно перейти на один вход', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP по линиям');
    await expect(page.getByLabel('Подключение')).toHaveValue('port');
    await page.getByLabel('Слотов под SIM').fill('2');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();

    const secrets = page.getByRole('region', { name: 'Входы линий шлюза «GOIP по линиям»' });
    await expect(secrets.getByRole('row', { name: /^Line 1 pt-/u })).toBeVisible();
    await expect(secrets.getByRole('row', { name: /^Line 2 pt-/u })).toBeVisible();

    await page.getByRole('link', { name: 'Открыть шлюз — порты и настройки →' }).click();
    // Настройки — построчно для каждой линии, теми же полями, что у линии в GOIP.
    const lines = page.getByRole('table', { name: 'Настройки линий' });
    // Префикс линии — в строке: без Routing Prefix GOIP ждёт тонового набора (2026-09-29).
    await expect(lines.getByRole('row', { name: /^Line 1 pt-/u })).toContainText('99001');
    await expect(lines.getByRole('row', { name: /^Line 2 pt-/u })).toContainText('не на связи');
    const ports = page.getByRole('region', { name: 'Порты' });

    await page.getByRole('button', { name: 'Перейти на один вход для шлюза' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Перейти на один вход для шлюза' })
      .click();
    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('Single Server Mode');
    await expect(ports.getByRole('row', { name: /^1 префикс 99001/u })).toBeVisible();
  });

  test('тестовый звонок с карты: окно с номером и понятный отказ, пока линия не на связи', async ({
    page,
  }) => {
    // ADR-0055. Живого FreeSWITCH на стенде нет — проверяется путь до узла: кнопка у карты,
    // окно, отказ словами партнёра, а не кодом.
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP для пробы');
    await page.getByLabel('Слотов под SIM').fill('1');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('button', { name: 'Записал, закрыть' }).click();

    // Источника оператора на стенде нет, и по номеру карта не заводится (см. «SIM вставляется
    // в порт по номеру…»). Карта заводится с явным оператором стенда и вставляется из вынутых.
    const operators = await page.request.get('/api/operators', {
      headers: { 'X-Zvonix-Web': '1' },
    });
    const operator = (await operators.json()) as { operators: { id: string; name: string }[] };
    const megafon = operator.operators.find((row) => row.name === 'МегаФон');
    expect(megafon).toBeDefined();
    const created = await page.request.post('/api/partner/sim-cards', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { msisdn: '+7 913 555-00-01', operatorId: megafon?.id },
    });
    expect(created.status()).toBe(201);
    await page.reload();

    const group = page.getByRole('region', { name: 'GOIP для пробы', exact: true });
    await group.getByRole('button', { name: 'Вставить SIM' }).click();
    const insert = page.getByRole('dialog');
    await insert.getByRole('combobox').selectOption({ label: '79135550001 · МегаФон' });
    await insert.getByRole('button', { name: 'Вставить' }).click();

    await group.getByRole('button', { name: 'Тестовый звонок' }).click();
    const dialog = page.getByRole('dialog', { name: 'Тестовый звонок' });
    await dialog.getByLabel('Куда звонить').fill('+7 913 000-11-22');
    await dialog.getByRole('button', { name: 'Позвонить' }).click();
    await expect(dialog).toContainText('Линия ещё не подключилась к площадке');
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
      .getByRole('link', { name: /Открыть/u })
      .click();

    await expect(page.getByText('Загружаем покрытие…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить регион' })).toHaveCount(0);
    // И не «список пуст — берёт любой регион»: до ответа это неправда.
    await expect(page.getByText('Список пуст')).toHaveCount(0);

    release();
    await expect(page.getByRole('button', { name: 'Добавить регион' })).toBeVisible();
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

  test('участник назван клиентом или партнёром, а не «участником»', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');

    // Строка — по ячейке с точным адресом: «applicant.client@…» содержит «client@…».
    const rowOf = (email: string) =>
      page.getByRole('row').filter({ has: page.getByRole('cell', { name: email, exact: true }) });
    await expect(rowOf(PEOPLE.client)).toContainText('Клиент «');
    await expect(rowOf(PEOPLE.partner)).toContainText('Партнёр «');
    await expect(page.getByRole('cell', { name: 'Участник', exact: true })).toHaveCount(0);
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

test.describe('ссылки из писем', () => {
  // Страниц не было: письмо с подтверждением адреса уходило, а ссылка из него вела
  // на 404 (владелец, 2026-09-23). Выдуманный код доходит до API и получает его отказ —
  // значит, страница есть и спрашивает нужный обработчик.
  test('подтверждение адреса: страница есть и говорит, что ссылка устарела', async ({ page }) => {
    await page.goto('/confirm-email?token=vydumannyy-kod-dlya-proverki');
    await expect(page.getByRole('heading', { name: 'Подтверждение адреса' })).toBeVisible();
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Перейти ко входу' })).toBeVisible();
  });

  test('подтверждение без кода в ссылке объясняет, что ссылку обрезали', async ({ page }) => {
    await page.goto('/confirm-email');
    await expect(page.getByText(/нет кода подтверждения/u)).toBeVisible();
  });

  test('обрезанная почтовой программой ссылка — «недействительна», а не отказ проверки', async ({
    page,
  }) => {
    await page.goto('/confirm-email?token=abc');
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByText('Данные запроса не прошли проверку')).toHaveCount(0);
  });

  test('новый пароль: несовпадение видно до отправки, устаревшая ссылка — после', async ({
    page,
  }) => {
    await page.goto('/reset-password?token=vydumannyy-kod-dlya-proverki');
    await page.getByLabel('Новый пароль').fill('Новый-пароль-2026');
    await page.getByLabel('Ещё раз').fill('Другой-пароль-2026');
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить пароль' })).toBeDisabled();

    await page.getByLabel('Ещё раз').fill('Новый-пароль-2026');
    await page.getByRole('button', { name: 'Сохранить пароль' }).click();
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Запросить новую ссылку' })).toBeVisible();
  });

  test('«Забыли пароль?» со входа ведёт к заявке, ответ не выдаёт, есть ли адрес', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Забыли пароль?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/u);
    await page.getByLabel('Адрес почты').fill('nikogo-net@e2e.zvonix.test');
    await page.getByRole('button', { name: 'Прислать ссылку' }).click();
    await expect(page.getByRole('heading', { name: 'Проверьте почту' })).toBeVisible();
    await expect(page.getByText(/Если адрес/u)).toBeVisible();
  });

  test('вход без подтверждённой почты объясняет, что делать, и присылает письмо заново', async ({
    page,
  }) => {
    // Человек с истёкшей ссылкой видел только «не активирована» и ждал администратора,
    // а войти, чтобы попросить новое письмо, не мог (владелец, 2026-09-23). Своя запись:
    // заявки из наполнения стенда меняют соседние тесты.
    const email = `resend-${String(Date.now())}@e2e.zvonix.test`;
    const registered = await page.request.post('/api/auth/register', {
      data: {
        email,
        password: PASSWORD,
        fullName: 'Лебедев Игорь',
        cabinet: 'client',
        answers: { companyName: 'Такси «Запад»', city: 'Пермь', phone: '+7 342 000-00-00' },
      },
    });
    expect(registered.status()).toBe(202);

    await page.goto('/login');
    await page.getByLabel('Адрес почты').fill(email);
    await page.getByLabel('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('Адрес почты не подтверждён.')).toBeVisible();
    await page.getByRole('button', { name: 'Прислать письмо ещё раз' }).click();
    await expect(page.getByText(/Письмо ушло на/u)).toBeVisible();
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
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    // Несовпадение ловится до отправки: опечатка в пароле единственного администратора
    // запирает площадку.
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();
    expect(posted).toBe(0);

    await page.getByLabel('Пароль ещё раз').fill('достаточно длинный пароль');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    await expect(page.getByText('Код первого запуска не подходит')).toBeVisible();

    await page.getByLabel('Код первого запуска').fill('B4PR-3N3H-CCP5');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    await expect(page.getByText('Администратор создан')).toBeVisible();
    await page.getByRole('link', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/login$/u);
  });
});
